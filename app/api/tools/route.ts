import { NextResponse } from "next/server";
import { listTools } from "@/lib/tools";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ tools: await listTools() });
  } catch {
    return NextResponse.json({ error: "Could not load tools." }, { status: 500 });
  }
}
