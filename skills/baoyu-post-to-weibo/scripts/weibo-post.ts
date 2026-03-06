import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import {
  CdpConnection,
  copyImageToClipboard,
  findChromeExecutable,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  getFreePort,
  pasteFromClipboard,
  sleep,
  waitForChromeDebugPort,
} from './weibo-utils.js';

const WEIBO_HOME_URL = 'https://weibo.com/';

interface WeiboPostOptions {
  text?: string;
  images?: string[];
  timeoutMs?: number;
  profileDir?: string;
  chromePath?: string;
}

export async function postToWeibo(options: WeiboPostOptions): Promise<void> {
  const { text, images = [], timeoutMs = 120_000, profileDir = getDefaultProfileDir() } = options;

  await mkdir(profileDir, { recursive: true });

  const existingPort = findExistingChromeDebugPort(profileDir);
  let port: number;

  if (existingPort) {
    console.log(`[weibo-post] Found existing Chrome on port ${existingPort}, reusing...`);
    port = existingPort;
  } else {
    const chromePath = options.chromePath ?? findChromeExecutable();
    if (!chromePath) throw new Error('Chrome not found. Set WEIBO_BROWSER_CHROME_PATH env var.');

    port = await getFreePort();
    console.log(`[weibo-post] Launching Chrome (profile: ${profileDir})`);

    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      WEIBO_HOME_URL,
    ];

    if (process.platform === 'darwin') {
      const appPath = chromePath.replace(/\/Contents\/MacOS\/Google Chrome$/, '');
      spawn('open', ['-na', appPath, '--args', ...chromeArgs], { stdio: 'ignore' });
    } else {
      spawn(chromePath, chromeArgs, { stdio: 'ignore' });
    }
  }

  let cdp: CdpConnection | null = null;

  try {
    const wsUrl = await waitForChromeDebugPort(port, 30_000);
    cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 15_000 });

    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    let pageTarget = targets.targetInfos.find((t) => t.type === 'page' && t.url.includes('weibo.com'));

    if (!pageTarget) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: WEIBO_HOME_URL });
      pageTarget = { targetId, url: WEIBO_HOME_URL, type: 'page' };
    }

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });

    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    await cdp.send('Input.setIgnoreInputEvents', { ignore: false }, { sessionId });

    console.log('[weibo-post] Waiting for Weibo editor...');
    await sleep(3000);

    const waitForEditor = async (): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const result = await cdp!.send<{ result: { value: boolean } }>('Runtime.evaluate', {
          expression: `!!document.querySelector('#homeWrap textarea')`,
          returnByValue: true,
        }, { sessionId });
        if (result.result.value) return true;
        await sleep(1000);
      }
      return false;
    };

    const editorFound = await waitForEditor();
    if (!editorFound) {
      console.log('[weibo-post] Editor not found. Please log in to Weibo in the browser window.');
      console.log('[weibo-post] Waiting for login...');
      const loggedIn = await waitForEditor();
      if (!loggedIn) throw new Error('Timed out waiting for Weibo editor. Please log in first.');
    }

    if (text) {
      console.log('[weibo-post] Typing text...');

      // Focus and use Input.insertText via CDP
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const editor = document.querySelector('#homeWrap textarea');
          if (editor) { editor.focus(); editor.value = ''; }
        })()`,
      }, { sessionId });
      await sleep(200);

      await cdp.send('Input.insertText', { text }, { sessionId });
      await sleep(500);

      // Verify text was entered
      const textCheck = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: `document.querySelector('#homeWrap textarea')?.value || ''`,
        returnByValue: true,
      }, { sessionId });

      if (textCheck.result.value.length > 0) {
        console.log(`[weibo-post] Text verified (${textCheck.result.value.length} chars)`);
      } else {
        console.warn('[weibo-post] Text input appears empty, trying execCommand fallback...');
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const editor = document.querySelector('#homeWrap textarea');
            if (editor) { editor.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); }
          })()`,
        }, { sessionId });
        await sleep(300);

        const textRecheck = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: `document.querySelector('#homeWrap textarea')?.value || ''`,
          returnByValue: true,
        }, { sessionId });
        console.log(`[weibo-post] Text after fallback: ${textRecheck.result.value.length} chars`);
      }
    }

    for (const imagePath of images) {
      if (!fs.existsSync(imagePath)) {
        console.warn(`[weibo-post] Image not found: ${imagePath}`);
        continue;
      }

      console.log(`[weibo-post] Pasting image: ${imagePath}`);

      if (!copyImageToClipboard(imagePath)) {
        console.warn(`[weibo-post] Failed to copy image to clipboard: ${imagePath}`);
        continue;
      }

      await sleep(500);

      await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('#homeWrap textarea')?.focus()`,
      }, { sessionId });
      await sleep(200);

      // Count images before paste
      const imgCountBefore = await cdp.send<{ result: { value: number } }>('Runtime.evaluate', {
        expression: `document.querySelectorAll('#homeWrap img[src^="blob:"], #homeWrap img[src^="data:"]').length`,
        returnByValue: true,
      }, { sessionId });

      console.log('[weibo-post] Pasting from clipboard...');
      pasteFromClipboard('Google Chrome', 5, 500);

      // Verify image appeared
      console.log('[weibo-post] Verifying image upload...');
      const expectedImgCount = imgCountBefore.result.value + 1;
      let imgUploadOk = false;
      const imgWaitStart = Date.now();
      while (Date.now() - imgWaitStart < 15_000) {
        const r = await cdp!.send<{ result: { value: number } }>('Runtime.evaluate', {
          expression: `document.querySelectorAll('#homeWrap img[src^="blob:"], #homeWrap img[src^="data:"]').length`,
          returnByValue: true,
        }, { sessionId });
        if (r.result.value >= expectedImgCount) {
          imgUploadOk = true;
          break;
        }
        await sleep(1000);
      }

      if (imgUploadOk) {
        console.log('[weibo-post] Image upload verified');
      } else {
        console.warn('[weibo-post] Image upload not detected after 15s. Check Accessibility permissions.');
      }
    }

    console.log('[weibo-post] Post composed. Please review and click the publish button in the browser.');
    console.log('[weibo-post] Browser remains open for manual review.');

  } finally {
    if (cdp) {
      cdp.close();
    }
  }
}

function printUsage(): never {
  console.log(`Post to Weibo using real Chrome browser

Usage:
  npx -y bun weibo-post.ts [options] [text]

Options:
  --image <path>   Add image (can be repeated, max 9)
  --profile <dir>  Chrome profile directory
  --help           Show this help

Examples:
  npx -y bun weibo-post.ts "Hello from CLI!"
  npx -y bun weibo-post.ts "Check this out" --image ./screenshot.png
  npx -y bun weibo-post.ts "Post it!" --image a.png --image b.png
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

  const images: string[] = [];
  let profileDir: string | undefined;
  const textParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--image' && args[i + 1]) {
      images.push(args[++i]!);
    } else if (arg === '--profile' && args[i + 1]) {
      profileDir = args[++i];
    } else if (!arg.startsWith('-')) {
      textParts.push(arg);
    }
  }

  const text = textParts.join(' ').trim() || undefined;

  if (!text && images.length === 0) {
    console.error('Error: Provide text or at least one image.');
    process.exit(1);
  }

  await postToWeibo({ text, images, profileDir });
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
