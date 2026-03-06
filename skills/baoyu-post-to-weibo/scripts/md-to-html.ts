import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

interface ImageInfo {
  placeholder: string;
  localPath: string;
  originalPath: string;
  alt: string;
  blockIndex: number;
}

interface ParsedMarkdown {
  title: string;
  summary: string;
  shortSummary: string;
  coverImage: string | null;
  contentImages: ImageInfo[];
  html: string;
  totalBlocks: number;
}

type FrontmatterFields = Record<string, unknown>;

function parseFrontmatter(content: string): { frontmatter: FrontmatterFields; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fields: FrontmatterFields = {};
  for (const line of match[1]!.split('\n')) {
    const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (kv) {
      let val = kv[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fields[kv[1]!] = val;
    }
  }

  return { frontmatter: fields, body: match[2]! };
}

function pickFirstString(fm: FrontmatterFields, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = fm[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function extractTitleFromBody(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : '';
}

function extractSummaryFromBody(body: string, maxLen: number): string {
  const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('```'));
  const firstParagraph = lines[0]?.replace(/[*_`\[\]()]/g, '').trim() || '';
  if (firstParagraph.length <= maxLen) return firstParagraph;
  return firstParagraph.slice(0, maxLen - 1) + '\u2026';
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });

    request.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
    request.setTimeout(30000, () => { request.destroy(); reject(new Error('Download timeout')); });
  });
}

function getImageExtension(urlOrPath: string): string {
  const match = urlOrPath.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  return match ? match[1]!.toLowerCase() : 'png';
}

function resolveLocalWithFallback(resolved: string): string {
  if (fs.existsSync(resolved)) return resolved;
  const ext = path.extname(resolved);
  const base = resolved.slice(0, -ext.length);
  const alternatives = [
    base + '.webp',
    base + '.jpg',
    base + '.jpeg',
    base + '.png',
    base + '.gif',
    base + '_original.png',
    base + '_original.jpg',
  ].filter((p) => p !== resolved);
  for (const alt of alternatives) {
    if (fs.existsSync(alt)) {
      console.error(`[md-to-html] Image fallback: ${path.basename(resolved)} → ${path.basename(alt)}`);
      return alt;
    }
  }
  return resolved;
}

async function resolveImagePath(imagePath: string, baseDir: string, tempDir: string): Promise<string> {
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    const hash = createHash('md5').update(imagePath).digest('hex').slice(0, 8);
    const ext = getImageExtension(imagePath);
    const localPath = path.join(tempDir, `remote_${hash}.${ext}`);
    if (!fs.existsSync(localPath)) {
      console.error(`[md-to-html] Downloading: ${imagePath}`);
      await downloadFile(imagePath, localPath);
    }
    return localPath;
  }
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(baseDir, imagePath);
  return resolveLocalWithFallback(resolved);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdownToHtml(body: string, imageCallback: (src: string, alt: string) => string): { html: string; totalBlocks: number } {
  const lines = body.split('\n');
  const htmlParts: string[] = [];
  let blockCount = 0;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        inCodeBlock = false;
        htmlParts.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        blockCount++;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // H1 (skip, used as title)
    if (line.match(/^#\s+/)) continue;

    // H2-H6
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      htmlParts.push(`<h${level}>${processInline(headingMatch[2]!)}</h${level}>`);
      blockCount++;
      continue;
    }

    // Image
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      htmlParts.push(imageCallback(imgMatch[2]!, imgMatch[1]!));
      blockCount++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      htmlParts.push(`<blockquote><p>${processInline(line.slice(2))}</p></blockquote>`);
      blockCount++;
      continue;
    }

    // Unordered list
    if (line.match(/^[-*]\s+/)) {
      htmlParts.push(`<li>${processInline(line.replace(/^[-*]\s+/, ''))}</li>`);
      blockCount++;
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s+/)) {
      htmlParts.push(`<li>${processInline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      blockCount++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*]{3,}$/)) {
      htmlParts.push('<hr>');
      continue;
    }

    // Empty line
    if (!line.trim()) continue;

    // Paragraph
    htmlParts.push(`<p>${processInline(line)}</p>`);
    blockCount++;
  }

  return { html: htmlParts.join('\n'), totalBlocks: blockCount };
}

function processInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export async function parseMarkdown(
  markdownPath: string,
  options?: { coverImage?: string; title?: string; tempDir?: string },
): Promise<ParsedMarkdown> {
  const content = fs.readFileSync(markdownPath, 'utf-8');
  const baseDir = path.dirname(markdownPath);
  const tempDir = options?.tempDir ?? path.join(os.tmpdir(), 'weibo-article-images');

  await mkdir(tempDir, { recursive: true });

  const { frontmatter, body } = parseFrontmatter(content);

  let title = options?.title?.trim() || pickFirstString(frontmatter, ['title']) || '';
  if (!title) title = extractTitleFromBody(body);
  if (!title) title = path.basename(markdownPath, path.extname(markdownPath));

  let summary = pickFirstString(frontmatter, ['summary', 'description', 'excerpt']) || '';
  if (!summary) summary = extractSummaryFromBody(body, 44);
  const shortSummary = extractSummaryFromBody(body, 44);

  let coverImagePath = options?.coverImage?.trim() || pickFirstString(frontmatter, [
    'featureImage', 'cover_image', 'coverImage', 'cover', 'image',
  ]) || null;

  const images: Array<{ src: string; alt: string }> = [];
  let imageCounter = 0;

  const { html, totalBlocks } = markdownToHtml(body, (src, alt) => {
    const placeholder = `WBIMGPH_${++imageCounter}`;
    images.push({ src, alt });
    return placeholder;
  });

  const contentImages: ImageInfo[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const localPath = await resolveImagePath(img.src, baseDir, tempDir);
    contentImages.push({
      placeholder: `WBIMGPH_${i + 1}`,
      localPath,
      originalPath: img.src,
      alt: img.alt,
      blockIndex: i,
    });
  }

  let resolvedCoverImage: string | null = null;
  if (coverImagePath) {
    resolvedCoverImage = await resolveImagePath(coverImagePath, baseDir, tempDir);
  }

  return {
    title,
    summary,
    shortSummary,
    coverImage: resolvedCoverImage,
    contentImages,
    html: html.replace(/\n{3,}/g, '\n\n').trim(),
    totalBlocks,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Convert Markdown to HTML for Weibo article publishing

Usage:
  npx -y bun md-to-html.ts <markdown_file> [options]

Options:
  --title <title>       Override title
  --cover <image>       Override cover image
  --output <json|html>  Output format (default: json)
  --help                Show this help
`);
    process.exit(0);
  }

  let markdownPath: string | undefined;
  let title: string | undefined;
  let coverImage: string | undefined;
  let outputFormat: 'json' | 'html' = 'json';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--title' && args[i + 1]) {
      title = args[++i];
    } else if (arg === '--cover' && args[i + 1]) {
      coverImage = args[++i];
    } else if (arg === '--output' && args[i + 1]) {
      outputFormat = args[++i] as 'json' | 'html';
    } else if (!arg.startsWith('-')) {
      markdownPath = arg;
    }
  }

  if (!markdownPath || !fs.existsSync(markdownPath)) {
    console.error('Error: Valid markdown file path required');
    process.exit(1);
  }

  const result = await parseMarkdown(markdownPath, { title, coverImage });

  if (outputFormat === 'html') {
    console.log(result.html);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
