import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['query', 'error'] : ['error'],
});

export async function logEvent(
  type: string,
  message: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await db.botEvent.create({
      data: { type, message, metadata: metadata as any },
    });
  } catch {
    // Non-critical — never crash bot over logging
  }
}
