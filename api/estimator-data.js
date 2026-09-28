// Vercel Serverless Function: proxies + caches the Airtable base so the Airtable
// token never reaches the browser, and Airtable's 5 req/sec rate limit can't be
// hit by real site traffic.
//
// Required env vars (set in Vercel project settings, never committed):
//   AIRTABLE_TOKEN    - Airtable Personal Access Token
//   AIRTABLE_BASE_ID  - Airtable base id (e.g. appXXXXXXXXXXXXXX)

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, fetchedAt: 0 };

async function fetchAllRecords(baseId, token, tableName) {
  const records = [];
  let offset;

  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Airtable fetch failed for ${tableName}: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);

  return records;
}

function buildEstimatorData(families, variants, specs, materials) {
  const materialsBySpec = new Map();
  materials.forEach((m) => {
    const specId = m.fields.Spec && m.fields.Spec[0];
    if (!specId) return;
    if (!materialsBySpec.has(specId)) materialsBySpec.set(specId, []);
    materialsBySpec.get(specId).push({
      item_name: m.fields.Name || '',
      category: m.fields.category || '',
      unit: m.fields.unit || '',
      floor_qty_per_m2: m.fields.floor_qty_per_m2 || 0,
      wall_qty_per_m2: m.fields.wall_qty_per_m2 || 0,
      package_unit: m.fields.package_unit || '',
      package_size: m.fields.package_size || 1,
      unit_price: m.fields.unit_price || 0,
      product_url: m.fields.product_url || ''
    });
  });

  const specsByVariant = new Map();
  specs.forEach((s) => {
    const variantId = s.fields.Variant && s.fields.Variant[0];
    if (!variantId) return;
    if (!specsByVariant.has(variantId)) specsByVariant.set(variantId, []);
    specsByVariant.get(variantId).push({
      spec_id: s.fields.spec_id || s.id,
      spec_name: s.fields.Name || '',
      thickness: {
        floor: s.fields.thickness_floor || '',
        wall: s.fields.thickness_wall || ''
      },
      materials: materialsBySpec.get(s.id) || []
    });
  });

  const variantsByFamily = new Map();
  variants.forEach((v) => {
    const familyId = v.fields.Family && v.fields.Family[0];
    if (!familyId) return;
    if (!variantsByFamily.has(familyId)) variantsByFamily.set(familyId, []);
    variantsByFamily.get(familyId).push({
      usage: v.fields.usage || 'NON_EXPOSED',
      label: v.fields.Name || '',
      specs: specsByVariant.get(v.id) || []
    });
  });

  return {
    families: families.map((f) => ({
      family_id: f.fields.family_id || f.id,
      family_name: f.fields.Name || '',
      variants: variantsByFamily.get(f.id) || []
    }))
  };
}

module.exports = async (req, res) => {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    res.status(500).json({ error: 'Server is missing AIRTABLE_TOKEN / AIRTABLE_BASE_ID env vars.' });
    return;
  }

  const isFresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (isFresh) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    res.status(200).json(cache.data);
    return;
  }

  try {
    const [families, variants, specs, materials] = await Promise.all([
      fetchAllRecords(baseId, token, 'Families'),
      fetchAllRecords(baseId, token, 'Variants'),
      fetchAllRecords(baseId, token, 'Specs'),
      fetchAllRecords(baseId, token, 'Materials')
    ]);

    const data = buildEstimatorData(families, variants, specs, materials);
    cache = { data, fetchedAt: Date.now() };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(data);
  } catch (error) {
    if (cache.data) {
      // Airtable hiccup - serve the last known-good copy instead of breaking the page.
      res.setHeader('X-Cache', 'STALE-FALLBACK');
      res.status(200).json(cache.data);
      return;
    }
    res.status(502).json({ error: 'Failed to load estimator data from Airtable.', detail: String(error) });
  }
};
