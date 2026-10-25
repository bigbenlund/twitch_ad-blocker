import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClientAdRequest, removeClientAds } from '../src/lib/gql.js';

const fetchAdsOp = { operationName: 'FetchAdsService_FetchAds', variables: { input: {} }, extensions: {} };
const videoAd = () => ({ data: { fetchAds: { __typename: 'FetchAdsPayload', error: null, ads: { __typename: 'FetchedVideoAd', format: 'OUTSTREAM_MIRROR_PBYP_VIDEO', vast: '<VAST/>' } } } });

test('isClientAdRequest', () => {
  assert.equal(isClientAdRequest(JSON.stringify(fetchAdsOp)), true);
  assert.equal(isClientAdRequest(JSON.stringify([{ operationName: 'ChannelShell' }, fetchAdsOp])), true);
  assert.equal(isClientAdRequest(JSON.stringify({ operationName: 'PlaybackAccessToken_Template' })), false);
  assert.equal(isClientAdRequest(undefined), false);
  assert.equal(isClientAdRequest(new Uint8Array(1)), false);
});

test('removeClientAds nulls the ad, keeps the response shape', () => {
  const json = videoAd();
  assert.deepEqual(removeClientAds(JSON.stringify(fetchAdsOp), json), ['OUTSTREAM_MIRROR_PBYP_VIDEO']);
  assert.deepEqual(json, { data: { fetchAds: { __typename: 'FetchAdsPayload', error: null, ads: null } } });
});

test('removeClientAds handles batches and leaves other operations alone', () => {
  const other = { data: { channel: { id: '1' } } };
  const display = { data: { fetchAds: { ads: { __typename: 'FetchedDisplayAd', ads: [{ format: 'X' }] } } } };
  const json = [other, display];
  const removed = removeClientAds(JSON.stringify([{ operationName: 'ChannelShell' }, fetchAdsOp]), json);
  assert.deepEqual(removed, ['FetchedDisplayAd']);
  assert.deepEqual(json[0], { data: { channel: { id: '1' } } });
  assert.equal(json[1].data.fetchAds.ads, null);
});

test('removeClientAds tolerates empty, error and malformed responses', () => {
  assert.deepEqual(removeClientAds(JSON.stringify(fetchAdsOp), { data: { fetchAds: { ads: null } } }), []);
  assert.deepEqual(removeClientAds(JSON.stringify(fetchAdsOp), { data: null, errors: [{ message: 'x' }] }), []);
  assert.deepEqual(removeClientAds('not json', videoAd()), []);
  assert.deepEqual(removeClientAds(JSON.stringify(fetchAdsOp), null), []);
});
