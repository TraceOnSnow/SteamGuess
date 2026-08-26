#!/usr/bin/env node

/**
 * Small PICS proof-of-concept for SteamGuess.
 *
 * It logs into Steam anonymously, requests AppInfo in batches, reads
 * appinfo.common.store_tags, and resolves the numeric tag IDs through Steam's
 * Store.GetLocalizedNameForTags service.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import SteamUser from 'steam-user';

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function projectPath(value) {
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

const DEFAULT_APPIDS = [730, 1245620, 1091500];
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 90_000;

function printHelp() {
  console.log(`Usage:
  npm run pics:tags -- [appids...] [options]

Examples:
  npm run pics:tags
  npm run pics:tags -- 730 1245620 1091500
  npm run pics:tags -- --file data/processed/appids_inter_20260225.json --limit 10
  npm run pics:tags -- 730 --language schinese --out /tmp/pics-tags.json

Options:
  --file <path>        Read appids from a JSON file ({"appids": [...]} or [...])
  --limit <number>     Only request the first N appids
  --batch-size <n>     PICS appids per batch (default: ${DEFAULT_BATCH_SIZE})
  --language <name>    Steam language name (default: english)
  --out <path>         Also write the complete result as JSON
  --no-stdout          Do not print the complete JSON payload to stdout
  --timeout <seconds>  Overall timeout (default: ${DEFAULT_TIMEOUT_MS / 1000})
  --help               Show this help
`);
}

function positiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    appids: [],
    file: '',
    limit: 0,
    batchSize: DEFAULT_BATCH_SIZE,
    language: 'english',
    out: '',
    stdout: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--file') {
      options.file = argv[++index] ?? '';
    } else if (arg === '--limit') {
      options.limit = positiveInteger(argv[++index], '--limit');
    } else if (arg === '--batch-size') {
      options.batchSize = positiveInteger(argv[++index], '--batch-size');
    } else if (arg === '--language') {
      options.language = argv[++index] ?? '';
    } else if (arg === '--out') {
      options.out = argv[++index] ?? '';
    } else if (arg === '--no-stdout') {
      options.stdout = false;
    } else if (arg === '--timeout') {
      options.timeoutMs = positiveInteger(argv[++index], '--timeout') * 1000;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.appids.push(arg);
    }
  }

  if (options.file === undefined || options.language === undefined || options.out === undefined) {
    throw new Error('An option is missing its value');
  }

  return options;
}

function normalizeAppids(values) {
  const appids = [];
  const seen = new Set();

  for (const value of values) {
    const appid = Number.parseInt(String(value), 10);
    if (!Number.isInteger(appid) || appid <= 0 || seen.has(appid)) continue;
    seen.add(appid);
    appids.push(appid);
  }

  return appids;
}

async function loadAppids(options) {
  const values = [...options.appids];

  if (options.file) {
    const parsed = JSON.parse(await readFile(projectPath(options.file), 'utf8'));
    if (Array.isArray(parsed)) {
      values.push(...parsed);
    } else if (parsed && (Array.isArray(parsed.appids) || Array.isArray(parsed.appIds))) {
      values.push(...(parsed.appids ?? parsed.appIds));
    } else if (parsed && Array.isArray(parsed.games)) {
      values.push(...parsed.games.map((game) => game?.appId));
    } else {
      throw new Error(`Unsupported appid file format: ${options.file}`);
    }
  }

  let appids = normalizeAppids(values);
  if (appids.length === 0) appids = [...DEFAULT_APPIDS];
  if (options.limit > 0) appids = appids.slice(0, options.limit);
  return appids;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function storeTagIds(appinfo) {
  const raw = appinfo?.common?.store_tags;
  if (!raw) return [];

  const values = Array.isArray(raw)
    ? raw
    : Object.entries(raw)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([, value]) => value);

  return normalizeAppids(values);
}

function logOnAnonymously(client) {
  return new Promise((resolve, reject) => {
    const onLoggedOn = (details) => {
      cleanup();
      resolve(details);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      client.off('loggedOn', onLoggedOn);
      client.off('error', onError);
    };

    client.once('loggedOn', onLoggedOn);
    client.once('error', onError);
    client.logOn({ anonymous: true });
  });
}

async function fetchProductInfo(client, appids, batchSize) {
  const apps = {};
  const unknownApps = [];
  const batches = chunk(appids, batchSize);

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.error(`[PICS] batch ${index + 1}/${batches.length}: ${batch.length} appids`);
    const response = await client.getProductInfo(batch, [], true);
    Object.assign(apps, response.apps);
    unknownApps.push(...response.unknownApps);
  }

  return { apps, unknownApps };
}

async function resolveTagNamesFromSteamClient(client, tagIds, language) {
  const tags = {};

  for (const batch of chunk(tagIds, 100)) {
    const response = await client.getStoreTagNames(language, batch);
    Object.assign(tags, response.tags);
  }

  return tags;
}

async function fetchStorefrontTagDictionary(language) {
  const url = `https://store.steampowered.com/tagdata/populartags/${encodeURIComponent(language)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'SteamGuess-PICS-PoC/0.1' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Storefront tag dictionary returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const entries = Array.isArray(payload) ? payload : Object.values(payload ?? {});
  const dictionary = {};
  for (const entry of entries) {
    const tagId = Number.parseInt(String(entry?.tagid ?? entry?.tag_id ?? ''), 10);
    if (!Number.isInteger(tagId)) continue;
    dictionary[tagId] = String(entry?.name ?? '');
  }
  return dictionary;
}

async function resolveTagNamesFromStorefront(tagIds, language) {
  const localized = await fetchStorefrontTagDictionary(language);
  const english = language === 'english'
    ? localized
    : await fetchStorefrontTagDictionary('english');
  const tags = {};

  for (const tagId of tagIds) {
    tags[tagId] = {
      name: localized[tagId] ?? '',
      englishName: english[tagId] ?? '',
    };
  }

  return tags;
}

async function resolveTagNames(client, tagIds, language) {
  try {
    return {
      source: 'steam-client:Store.GetLocalizedNameForTags',
      tags: await resolveTagNamesFromSteamClient(client, tagIds, language),
    };
  } catch (error) {
    console.error(
      `[PICS] Steam client tag-name lookup failed; falling back to Storefront dictionary: ${error.message}`,
    );
    return {
      source: 'storefront:tagdata/populartags',
      tags: await resolveTagNamesFromStorefront(tagIds, language),
    };
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const appids = await loadAppids(options);
  console.error(`[PICS] requesting ${appids.length} appids as an anonymous Steam user`);

  // Disable steam-user's persistent cache so this PoC doesn't write credentials
  // or machine data outside the repository.
  const client = new SteamUser({ dataDirectory: null });
  let timeout;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Timed out after ${options.timeoutMs / 1000} seconds`)),
        options.timeoutMs,
      );
    });

    const workPromise = (async () => {
      await logOnAnonymously(client);
      console.error('[PICS] anonymous login successful');

      const productInfo = await fetchProductInfo(client, appids, options.batchSize);
      const uniqueTagIds = [
        ...new Set(
          Object.values(productInfo.apps).flatMap((entry) => storeTagIds(entry.appinfo)),
        ),
      ];
      const tagResolution = uniqueTagIds.length
        ? await resolveTagNames(client, uniqueTagIds, options.language)
        : { source: 'none', tags: {} };
      const tagNames = tagResolution.tags;

      const games = {};
      for (const appid of appids) {
        const entry = productInfo.apps[appid];
        if (!entry) continue;

        const common = entry.appinfo?.common ?? {};
        const tagIds = storeTagIds(entry.appinfo);
        games[appid] = {
          appId: appid,
          name: common.name ?? '',
          type: common.type ?? '',
          changeNumber: entry.changenumber,
          missingToken: entry.missingToken,
          tags: tagIds.map((tagId, index) => ({
            id: tagId,
            rank: index + 1,
            name: tagNames[tagId]?.name ?? '',
            englishName: tagNames[tagId]?.englishName ?? '',
          })),
        };
      }

      return {
        generatedAt: new Date().toISOString(),
        language: options.language,
        tagNameSource: tagResolution.source,
        requestedAppIds: appids,
        unknownAppIds: productInfo.unknownApps,
        games,
      };
    })();

    const result = await Promise.race([workPromise, timeoutPromise]);
    const json = JSON.stringify(result, null, 2);
    if (options.stdout) {
      console.log(json);
    }

    if (options.out) {
      await writeFile(projectPath(options.out), `${json}\n`, 'utf8');
      console.error(`[PICS] wrote ${options.out}`);
    }
  } finally {
    clearTimeout(timeout);
    client.logOff();
  }
}

run().catch((error) => {
  console.error(`[PICS] ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
});
