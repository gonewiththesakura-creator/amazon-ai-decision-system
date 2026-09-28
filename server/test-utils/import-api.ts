import type { Express } from 'express';
import request from 'supertest';

export async function previewAndConfirmCsv(
  app: Express,
  csv: string,
  filename: string,
  fields: Record<string, string> = {},
) {
  let upload = request(app).post('/api/import/preview/csv');
  for (const [name, value] of Object.entries(fields)) upload = upload.field(name, value);
  const response = await upload.attach('file', Buffer.from(csv), filename).expect(200);
  let preview = response.body.data as { token: string; entityType: string | null };
  if (!preview.entityType) {
    if (!fields.entityType) throw new Error('未知文件类型必须指定 entityType 才能确认导入。');
    const selected = await request(app).post('/api/import/preview/type')
      .send({ token: preview.token, entityType: fields.entityType }).expect(200);
    preview = selected.body.data as typeof preview;
  }
  return request(app).post('/api/import/confirm').send({ token: preview.token }).expect(201);
}
