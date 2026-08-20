export function narinfoUrl(cacheUrl: string, storePathHash: string): string {
  const url = new URL(cacheUrl);
  // Nix consumes the query as store settings; it does not send it to the cache server.
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${storePathHash}.narinfo`;
  return url.toString();
}
