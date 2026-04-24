import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const FREQUENCIES = new Set(["weekly", "biweekly", "monthly"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Record<string, unknown>;
  const client_id = body.client_id as string | undefined;

  if (!client_id) {
    return NextResponse.json({ error: "client_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const update: Record<string, unknown> = {};

  if (body.frequency !== undefined) {
    const freq = body.frequency as string | null;
    if (freq === null || freq === "" || freq === "off") {
      update.report_frequency = null;
      update.report_day_of_week = null;
      update.report_day_of_month = null;
    } else if (FREQUENCIES.has(freq)) {
      update.report_frequency = freq;
    } else {
      return NextResponse.json(
        { error: `Invalid frequency '${freq}'` },
        { status: 400 }
      );
    }
  }

  if (body.day_of_week !== undefined && body.day_of_week !== null) {
    const dow = Number(body.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return NextResponse.json(
        { error: "day_of_week must be 0-6 (Sunday=0)" },
        { status: 400 }
      );
    }
    update.report_day_of_week = dow;
  } else if (body.day_of_week === null) {
    update.report_day_of_week = null;
  }

  if (body.day_of_month !== undefined && body.day_of_month !== null) {
    const dom = Number(body.day_of_month);
    const valid = Number.isInteger(dom) && ((dom >= 1 && dom <= 28) || dom === -1);
    if (!valid) {
      return NextResponse.json(
        { error: "day_of_month must be 1-28 or -1 (last day)" },
        { status: 400 }
      );
    }
    update.report_day_of_month = dom;
  } else if (body.day_of_month === null) {
    update.report_day_of_month = null;
  }

  if (body.time_of_day !== undefined) {
    const time = body.time_of_day as string | null;
    if (time === null || time === "") {
      update.report_time_of_day = null;
    } else if (typeof time === "string" && TIME_RE.test(time)) {
      update.report_time_of_day = time;
    } else {
      return NextResponse.json(
        { error: "time_of_day must be 'HH:MM' (24h)" },
        { status: 400 }
      );
    }
  }

  if (body.timezone !== undefined) {
    const tz = body.timezone as string | null;
    if (tz === null || tz === "") {
      update.report_timezone = null;
    } else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        update.report_timezone = tz;
      } catch {
        return NextResponse.json(
          { error: `Invalid IANA timezone '${tz}'` },
          { status: 400 }
        );
      }
    }
  }

  // Biweekly anchor — if client switched to biweekly and no anchor is set,
  // stamp it now so the "on-week" cadence is deterministic from here.
  if (body.schedule_start !== undefined) {
    update.report_schedule_start = body.schedule_start || null;
  }

  if (body.recipients !== undefined) {
    const recipients = body.recipients as string[] | null;
    update.report_recipients =
      recipients && recipients.length > 0 ? recipients : null;
  }

  const { error } = await admin
    .from("clients")
    .update(update)
    .eq("id", client_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
