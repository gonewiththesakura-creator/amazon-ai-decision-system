import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from './database/database.js';

it('requires the reviewed declaration version to replace a pending roster over HTTP', async () => {
  const database = openDatabase(':memory:');
  try {
    const app = createApp({ database });
    const header = 'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationFamilyKey,parentLookupStatus,variationTheme,marketNode,monitoringEnabled,status';
    const original = `${header}\nUS,B0OWNED001,OWN-1,Owned,Brand,,pillow,,,pending,,Contour,true,active`;
    const corrected = original.replace('B0OWNED001', 'B0OWNED002');
    await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from(original), 'master.csv').expect(200);
    const declaration = await request(app).get('/api/import/owned-roster').expect(200);
    expect(declaration.body.data).toMatchObject({
      marketplace: 'US', declaredCount: 1, status: 'pending_validation',
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from(corrected), 'corrected.csv').expect(409);
    await request(app).post('/api/import/preview/csv')
      .field('supersedesRosterDigest', declaration.body.data.previewDigest)
      .attach('file', Buffer.from(corrected), 'corrected.csv').expect(200);
    await request(app).post('/api/import/preview/csv')
      .field('supersedesRosterDigest', declaration.body.data.previewDigest)
      .attach('file', Buffer.from(original), 'stale.csv').expect(409);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    database.prepare("UPDATE app_settings SET role = 'viewer' WHERE id = 1").run();
    await request(app).get('/api/import/owned-roster').expect(403);
  } finally { database.close(); }
});
