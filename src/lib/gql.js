// Client-side ads the Twitch page requests over GraphQL, outside the video stream. Used by the page
// hook. FetchAdsService_FetchAds returns e.g. the "picture-by-picture" mirror ad played in a box
// beside the stream (format OUTSTREAM_MIRROR_PBYP_VIDEO). The page treats
// { fetchAds: { ads: null } } as "no ad available" (from its fetchAds handler, 2026-10-25).

export const CLIENT_AD_OPERATIONS = ['FetchAdsService_FetchAds'];

export const isClientAdRequest = (body) => typeof body === 'string' && CLIENT_AD_OPERATIONS.some((op) => body.includes(op));

// Removes ads from client-ad operations in a GraphQL response. `body` is the request body (one
// operation or a batch array) and `json` the parsed response in the same shape; `json` is modified
// in place. Returns the formats removed.
export function removeClientAds(body, json) {
  let ops;
  try {
    ops = JSON.parse(body);
  } catch {
    return [];
  }
  const requests = Array.isArray(ops) ? ops : [ops];
  const responses = Array.isArray(json) ? json : [json];
  const removed = [];
  requests.forEach((op, i) => {
    if (!CLIENT_AD_OPERATIONS.includes(op?.operationName)) return;
    const fetchAds = responses[i]?.data?.fetchAds;
    if (!fetchAds?.ads) return;
    removed.push(fetchAds.ads.format ?? fetchAds.ads.__typename ?? 'unknown');
    fetchAds.ads = null;
  });
  return removed;
}
