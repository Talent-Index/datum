import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/** One photograph of a listing, by position. Public: the listing is. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await context.params;
  const position = Number.parseInt(n, 10);
  if (!Number.isInteger(position) || position < 0) return NextResponse.json({ error: "Bad image index" }, { status: 400 });
  const [row] = await db()
    .select({ data: schema.listingImages.dataBase64, type: schema.listingImages.contentType })
    .from(schema.listingImages)
    .where(and(eq(schema.listingImages.listingId, id), eq(schema.listingImages.position, position)));
  if (!row) return NextResponse.json({ error: "No such image" }, { status: 404 });
  return new NextResponse(Buffer.from(row.data, "base64"), {
    headers: { "content-type": row.type, "cache-control": "public, max-age=3600" },
  });
}
