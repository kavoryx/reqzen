export function targetForAsset(name) {
  if (typeof name !== 'string') return null;
  const filename = name.toLowerCase();
  if (filename.endsWith('.exe') && /(?:^|[-_.])x64(?:[-_.]|$)/.test(filename)) return 'windows';
  if (filename.endsWith('.dmg') && /(?:^|[-_.])arm64(?:[-_.]|$)/.test(filename)) return 'macos-arm64';
  if (filename.endsWith('.dmg') && /(?:^|[-_.])x64(?:[-_.]|$)/.test(filename)) return 'macos-x64';
  return null;
}

export function indexAssets(assets) {
  const candidates = {};
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string') continue;
    const target = targetForAsset(asset.name);
    if (target) (candidates[target] ||= []).push(asset);
  }
  return Object.fromEntries(
    Object.entries(candidates).map(([target, matches]) => [target, matches.length === 1 ? matches[0] : null])
  );
}
