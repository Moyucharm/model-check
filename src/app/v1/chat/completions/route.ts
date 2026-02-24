import { NextResponse } from "next/server";

function notFound() {
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}

export async function GET() { return notFound(); }
export async function POST() { return notFound(); }
export async function PUT() { return notFound(); }
export async function PATCH() { return notFound(); }
export async function DELETE() { return notFound(); }
