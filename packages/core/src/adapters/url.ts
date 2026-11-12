/** baseUrl 拼接：去掉尾部斜杠；若 baseUrl 已带版本段（/v1、/v1beta）则不重复加。 */
export function trimSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function joinUrl(baseUrl: string, version: string, path: string): string {
  const base = trimSlash(baseUrl);
  const withVersion = base.endsWith(version) ? base : `${base}${version}`;
  return `${withVersion}${path}`;
}
