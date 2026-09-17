import { NextResponse } from "next/server";
import { z } from "zod";

import { checkOperatorSecret, setOperatorCookie } from "@/lib/auth";

const bodySchema = z.object({ secret: z.string().min(1) });

/** The register page signs in with the operator secret once per browser. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !checkOperatorSecret(parsed.data.secret)) {
    return NextResponse.json({ error: "Operator secret not recognised" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  setOperatorCookie(response);
  return response;
}
