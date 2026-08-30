import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Kenyan public registers.
 *
 * None of these publish an API. This module gives each one a uniform
 * adapter backed by a local CSV, so the pipeline is written against a
 * stable interface today and the acquisition method can change without
 * touching anything above.
 *
 * Acquisition, per source, honestly stated:
 *
 *   NCA register of contractors
 *     Portal at nca.go.ke. Search is public, bulk export is not. Section 25
 *     of the NCA Act lets the Authority deregister contractors who default
 *     on annual licence renewal, and a deregistered contractor cannot
 *     re-register under a different name. That makes deregistration a
 *     permanent, checkable negative signal worth capturing. Get bulk access
 *     by asking: the NCA has an institutional interest in the same outcome
 *     you do.
 *
 *   EBK project registration
 *     Launched December 2025. Engineers register a project and receive a
 *     unique number before drawings go to the county. A live site with no
 *     registration number is a real risk flag, and almost nobody is
 *     checking this yet.
 *
 *   Kenya Gazette
 *     Genuinely public at kenyalaw.org. Insolvency notices, winding-up
 *     petitions and liquidator appointments against a developer are the
 *     strongest negative signal available and cost nothing.
 *
 *   Business Registration Service
 *     Company particulars, directors and registered charges via eCitizen.
 *     Paid per search, no bulk. Budget for it on named developers only.
 *
 * Legal note: scraping any of these is a terms question, not just a
 * technical one, and director details are personal data under the Data
 * Protection Act 2019. Register with the ODPC and document a lawful basis
 * before you hold this at scale. That is a week of work now and a dead
 * deal later.
 */

const dataDir = () =>
  process.env.DATA_REGISTERS ?? resolve(process.cwd(), "fixtures", "registers");

export interface ContractorRecord {
  name: string;
  ncaNumber: string;
  category: string;
  status: string; // active | lapsed | deregistered
  licenceExpiry: string | null; // ISO date
  source: "nca";
}

export interface GazetteNotice {
  company: string;
  noticeType: string; // winding-up | insolvency | liquidator | charge
  gazetteDate: string | null; // ISO date
  reference: string;
}

export interface DeveloperCheck {
  name: string;
  contractor: ContractorRecord | null;
  notices: GazetteNotice[];
  projectRegistered: boolean | null;
  flags: string[];
  verdict: string;
}

function rows(filename: string): Array<Record<string, string>> {
  let text: string;
  try {
    text = readFileSync(join(dataDir(), filename), "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  // The register fixtures contain no quoted fields, so a plain split is a
  // faithful port of csv.DictReader for this data.
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((column, i) => {
      row[column] = cells[i] ?? "";
    });
    return row;
  });
}

function isoDate(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

const NOISE_WORDS = new Set(["ltd", "limited", "company", "co", "and", "the", "&"]);

function norm(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[.,]+|[.,]+$/g, ""))
    .filter((word) => word && !NOISE_WORDS.has(word))
    .join(" ");
}

export function findContractor(name: string): ContractorRecord | null {
  const target = norm(name);
  for (const row of rows("nca_contractors.csv")) {
    if (norm(row.name ?? "") === target) {
      return {
        name: row.name ?? "",
        ncaNumber: row.nca_number ?? "",
        category: row.category ?? "",
        status: row.status ?? "",
        licenceExpiry: isoDate(row.licence_expiry),
        source: "nca",
      };
    }
  }
  return null;
}

export function findNotices(name: string): GazetteNotice[] {
  const target = norm(name);
  const out: GazetteNotice[] = [];
  for (const row of rows("gazette_notices.csv")) {
    if (norm(row.company ?? "") === target) {
      out.push({
        company: row.company ?? "",
        noticeType: row.notice_type ?? "",
        gazetteDate: isoDate(row.gazette_date),
        reference: row.reference ?? "",
      });
    }
  }
  return out.sort((a, b) => (b.gazetteDate ?? "").localeCompare(a.gazetteDate ?? ""));
}

export function projectIsRegistered(projectRef: string): boolean | null {
  const registered = rows("ebk_projects.csv");
  if (!registered.length) return null;
  return registered.some((row) => (row.project_ref ?? "").trim() === projectRef.trim());
}

/**
 * Combine the registers into one verdict.
 *
 * Ordered by severity: an insolvency notice outranks a lapsed licence, and
 * a deregistration outranks both because it is permanent.
 */
export function checkDeveloper(
  name: string,
  projectRef: string | null = null,
  today: string = new Date().toISOString().slice(0, 10),
): DeveloperCheck {
  const contractor = findContractor(name);
  const notices = findNotices(name);
  const registered = projectRef !== null ? projectIsRegistered(projectRef) : null;

  const flags: string[] = [];

  if (contractor === null) {
    flags.push("Not found in the NCA register of contractors");
  } else if (contractor.status === "deregistered") {
    flags.push(
      `Deregistered by the NCA and barred from re-registering (${contractor.ncaNumber})`,
    );
  } else if (contractor.status === "lapsed") {
    flags.push(`NCA licence lapsed (${contractor.ncaNumber})`);
  } else if (contractor.licenceExpiry && contractor.licenceExpiry < today) {
    flags.push(`NCA licence expired ${contractor.licenceExpiry}`);
  }

  for (const notice of notices) {
    if (["winding-up", "insolvency", "liquidator"].includes(notice.noticeType)) {
      flags.push(
        `Gazette ${notice.noticeType} notice dated ${notice.gazetteDate} (${notice.reference})`,
      );
    }
  }

  if (registered === false) {
    flags.push("No EBK project registration found for this project reference");
  }

  const severe = flags.some((flag) =>
    ["deregistered", "winding-up", "insolvency", "liquidator"].some((k) =>
      flag.toLowerCase().includes(k),
    ),
  );

  let verdict: string;
  if (severe) verdict = "do not proceed";
  else if (flags.length) verdict = "proceed with conditions";
  else if (contractor) verdict = "clear";
  else verdict = "unknown";

  return { name, contractor, notices, projectRegistered: registered, flags, verdict };
}
