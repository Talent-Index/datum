/**
 * Show what a deployment already has. Balances live on Avalanche Fuji and
 * are read by /api/state and /api/board; this script does not insert
 * payments, verdicts, or sample shillings.
 *
 * When the database is empty, open a build from the register as an
 * operator. That deploys the escrow. A project row without a contract
 * address is ignored by the app, so do not insert one by hand.
 *
 *   DATABASE_URL=... npm run db:migrate
 *   DATABASE_URL=... npm run seed
 */
import { listProjects } from "../lib/project";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not set. Point it at Postgres, run npm run db:migrate, then run this again.");
    return;
  }
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log("No projects with a contract address yet.");
    console.log("Sign in on /register with OPERATOR_SECRET and use New build. That deploys an escrow on Fuji from PLATFORM_KEY, ORACLE_KEY and SURVEYOR_KEY.");
    console.log("The register then lists every project without ?project=.");
    return;
  }
  console.log(`${projects.length} project${projects.length === 1 ? "" : "s"} already on this database. The register reads their balances from Fuji.`);
  for (const project of projects) {
    console.log(`- ${project.id}: ${project.name} (${project.developerName}) ${project.contractAddress}`);
  }
  console.log("Cover photos for the current pilot builds are in public/covers/. A listing photograph, when one was uploaded, is shown instead.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
