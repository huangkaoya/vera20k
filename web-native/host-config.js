// Regular Cloudflare/local deployments keep their engine and catalog on their
// own origin. The Toy export bundles them and retains this origin for multiplayer.
export const serviceOrigin = '';
export const staticRelease = null;
// Populated only after the resource-tool uploads have passed Toy review.
export const resourcePackUrls = [];
