import { discoverQuotaProducts, fetchQuotaProducts } from './registry.js';

function fail(message) {
  throw new Error(message);
}

function parseFetchArguments(args) {
  const products = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') continue;
    if (argument !== '--product') fail(`Unknown quota fetch option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail('Option --product requires a value.');
    products.push(value);
    index += 1;
  }
  if (!products.length) fail('quota fetch requires at least one --product.');
  return products;
}

export async function runQuota(args) {
  const subcommand = args[0];
  if (subcommand === 'discover') {
    const unknown = args.slice(1).filter(argument => argument !== '--json');
    if (unknown.length) fail(`Unknown quota discover option: ${unknown[0]}`);
    console.log(JSON.stringify(discoverQuotaProducts()));
    return;
  }
  if (subcommand === 'fetch') {
    console.log(JSON.stringify(await fetchQuotaProducts(parseFetchArguments(args.slice(1)))));
    return;
  }
  fail(`Unknown quota subcommand: ${subcommand || '(none)'}`);
}
