"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { AddressLink, NavLinks, TxLink } from "@/lib/ui/nav";
import { call, kes, useProject } from "@/lib/ui/project";
import { ActivityFeed, ReviewPanels } from "@/lib/ui/review";

/**
 * One page for whoever you are here: prove the number, open the account,
 * pass the identity check, then do the work of your role. Buyers see what
 * they committed to; sellers, developers and companies list; trustees
 * review and countersign.
 */

interface AccountView {
  session: { phone: string } | null;
  account: {
    id: number;
    phone: string;
    role: string;
    display_name: string;
    company_name: string | null;
    address: string;
    kyc_status: string;
    registry_tx: string | null;
  } | null;
  kyc: {
    id: number;
    status: string;
    full_name: string;
    id_type: string;
    id_last4: string;
    document: string;
    note: string | null;
    tx: string | null;
  } | null;
  listings: Array<{ id: string; kind: string; title: string; status: string; price_kes: number; project_id: string | null; note: string | null; tx: string | null }>;
  commitments: Array<{ project_id: string; commitment: number | null; wallet: string; name: string }>;
  trustee_of: Array<{ id: string; name: string }>;
}

const ROLE_COPY: Record<string, string> = {
  buyer: "You commit to a listed home or plot and pay in instalments that sit in escrow until the work is proven.",
  seller: "You advertise a property that exists. Once your identity is verified and a trustee approves the listing, buyers pay into escrow and the money reaches you on handover.",
  developer: "You build. Each milestone you photograph and a trustee countersigns releases that stage's share to your address.",
  company: "Your company raises for a development. Buyers commit against the target and every release is signed by a trustee.",
  trustee: "You hold the second signature. You verify identities, approve listings, and countersign milestones from the photographs.",
};

const KIND_BY_ROLE: Record<string, string[]> = {
  seller: ["property_sale"],
  developer: ["build", "development"],
  company: ["development", "property_sale"],
};

const MILESTONE_TEMPLATE = [
  "Foundation complete | foundation | 20",
  "Ground floor slab | ground_slab | 20",
  "Superstructure to roof level | superstructure | 25",
  "Roof on | roofing | 20",
  "Finishes complete | finishing | 15",
].join("\n");

export default function AccountPage() {
  const { toast, busy, showToast, act } = useProject();
  const [view, setView] = useState<AccountView | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [open, setOpen] = useState({ role: "buyer", displayName: "", companyName: "", registrationNumber: "" });
  const [kycForm, setKycForm] = useState({ fullName: "", idType: "national_id", idNumber: "" });
  const docRef = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState({
    id: "", kind: "", title: "", description: "", locationName: "", latitude: "-1.2921", longitude: "36.7827", priceKes: "", milestones: MILESTONE_TEMPLATE,
  });

  const load = useCallback(async () => {
    const r = await fetch("/api/account", { cache: "no-store" });
    if (r.ok) setView((await r.json()) as AccountView);
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10000);
    return () => clearInterval(id);
  }, [load]);

  const account = view?.account ?? null;
  const signedIn = view?.session?.phone ?? null;
  const kinds = account ? (KIND_BY_ROLE[account.role] ?? []) : [];
  const listingKind = listing.kind || kinds[0] || "";

  const sendCode = () => act("otp", async () => { const r = await call("/api/auth/otp", { phone: phone.trim() }); setCodeSent(true); showToast(String(r.message ?? "Code sent.")); });
  const verifyCode = () => act("verify", async () => { await call("/api/auth/verify", { phone: phone.trim(), code: code.trim() }); setCode(""); setCodeSent(false); await load(); });
  const signOut = () => act("logout", async () => { await call("/api/auth/logout"); await load(); });

  const openAccount = () =>
    act("open", async () => {
      const r = await call("/api/account", { ...open, companyName: open.companyName || undefined, registrationNumber: open.registrationNumber || undefined });
      showToast(String(r.message));
      await load();
    });

  const submitKyc = () =>
    act("kyc", async () => {
      const file = docRef.current?.files?.[0];
      if (!file) { showToast("Attach the document first.", true); return; }
      const form = new FormData();
      form.append("fullName", kycForm.fullName);
      form.append("idType", kycForm.idType);
      form.append("idNumber", kycForm.idNumber);
      form.append("document", file);
      const r = await call("/api/kyc", form);
      showToast(String(r.message));
      if (docRef.current) docRef.current.value = "";
      await load();
    });

  const postListing = () =>
    act("list", async () => {
      const milestones = listingKind === "property_sale" ? undefined : listing.milestones.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const [description = "", stage = "", percent = ""] = line.split("|").map((s) => s.trim());
        return { description, stage, percent: Number.parseInt(percent, 10) };
      });
      const r = await call("/api/listings", {
        id: listing.id.trim(), kind: listingKind, title: listing.title.trim(), description: listing.description.trim(),
        locationName: listing.locationName.trim(), latitude: Number.parseFloat(listing.latitude), longitude: Number.parseFloat(listing.longitude),
        priceKes: Number.parseInt(listing.priceKes, 10), milestones,
      });
      showToast(String(r.message));
      setListing((v) => ({ ...v, id: "", title: "", description: "", priceKes: "" }));
      await load();
    });

  const kycBadge = account ? ({ none: "not started", pending: "under review", verified: "verified", rejected: "not verified" } as Record<string, string>)[account.kyc_status] : "";

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>{account ? `${account.display_name}` : "Your account"}</h1>
        <div className="meta">
          <NavLinks current="account" />
          {account && (
            <span>Role <b>{account.role}</b></span>
          )}
          {account && (
            <span>Identity <b>{kycBadge}</b></span>
          )}
          {signedIn && (
            <span>
              <b>{signedIn}</b>{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>sign out</a>
            </span>
          )}
        </div>
      </header>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}

      {!signedIn && (
        <div className="cols">
          <section className="panel">
            <h2><span>Prove your number</span><span>One-time code by SMS</span></h2>
            <div className="body">
              <p>Every account is tied to an M-Pesa number. We send a six-digit code to it; nothing else is asked of you.</p>
              <div className="row">
                <div>
                  <label htmlFor="phone">M-Pesa number</label>
                  <input id="phone" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={codeSent} />
                </div>
                {codeSent && (
                  <div>
                    <label htmlFor="code">Code from SMS</label>
                    <input id="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
                  </div>
                )}
              </div>
              <div className="btns">
                {codeSent ? (
                  <>
                    <button onClick={verifyCode} disabled={busy !== null || code.length !== 6}>Verify</button>
                    <button className="ghost" onClick={() => setCodeSent(false)} disabled={busy !== null}>Change number</button>
                  </>
                ) : (
                  <button onClick={sendCode} disabled={busy !== null || !phone.trim()}>{busy === "otp" ? "Sending…" : "Send me a code"}</button>
                )}
              </div>
            </div>
          </section>
          <section className="panel">
            <h2><span>Who is here</span></h2>
            <div className="body">
              {Object.entries(ROLE_COPY).map(([role, copy]) => (
                <p key={role}><b style={{ textTransform: "capitalize" }}>{role}.</b> {copy}</p>
              ))}
            </div>
          </section>
        </div>
      )}

      {signedIn && !account && (
        <div className="cols">
          <section className="panel">
            <h2><span>Open your account</span><span>{signedIn}</span></h2>
            <div className="body">
              <p>Choose what you are here to do. The role is chosen once, and an Avalanche address is created for you the moment the account opens.</p>
              <label htmlFor="role">I am a</label>
              <select id="role" value={open.role} onChange={(e) => setOpen((v) => ({ ...v, role: e.target.value }))}>
                <option value="buyer">Buyer</option>
                <option value="seller">Seller of an existing property</option>
                <option value="developer">Developer or builder</option>
                <option value="company">Company</option>
              </select>
              <label htmlFor="name">{open.role === "company" ? "Contact person" : "Your name"}</label>
              <input id="name" value={open.displayName} onChange={(e) => setOpen((v) => ({ ...v, displayName: e.target.value }))} />
              {open.role === "company" && (
                <div className="row">
                  <div>
                    <label htmlFor="cname">Registered company name</label>
                    <input id="cname" value={open.companyName} onChange={(e) => setOpen((v) => ({ ...v, companyName: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="creg">Registration number</label>
                    <input id="creg" value={open.registrationNumber} onChange={(e) => setOpen((v) => ({ ...v, registrationNumber: e.target.value }))} />
                  </div>
                </div>
              )}
              <button onClick={openAccount} disabled={busy !== null || open.displayName.trim().length < 2}>
                {busy === "open" ? "Opening and registering on chain…" : "Open account"}
              </button>
              <p className="hint">{ROLE_COPY[open.role]}</p>
            </div>
          </section>
        </div>
      )}

      {account && (
        <div className="cols">
          <div>
            <section className="panel">
              <h2><span>Your address</span><span>Avalanche Fuji</span></h2>
              <div className="body">
                <p>{ROLE_COPY[account.role]}</p>
                <table>
                  <tbody>
                    <tr><td>Address</td><td className="n"><AddressLink address={account.address} /></td></tr>
                    <tr><td>Registered on chain</td><td className="n"><TxLink hash={account.registry_tx} /></td></tr>
                    <tr><td>Identity</td><td className="n">{kycBadge}</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            {account.role !== "trustee" && account.kyc_status !== "verified" && (
              <section className="panel">
                <h2><span>Identity check</span><span>{kycBadge}</span></h2>
                <div className="body">
                  {account.kyc_status === "pending" && view?.kyc ? (
                    <p>Submitted as <b>{view.kyc.full_name}</b>, {view.kyc.id_type.replace(/_/g, " ")} ending {view.kyc.id_last4}. A trustee is reviewing it.</p>
                  ) : (
                    <>
                      <p>
                        {account.role === "buyer"
                          ? "Optional for buyers, but a verified buyer's commitments carry more weight with sellers."
                          : "Required before you can list. A trustee reviews it and the verdict is written on chain against the document's hash. The document itself is not kept."}
                      </p>
                      {view?.kyc?.status === "rejected" && <div className="toast err">Not verified{view.kyc.note ? `: ${view.kyc.note}` : ""}. You can submit again.</div>}
                      <label htmlFor="kfull">{account.role === "company" ? "Name as registered" : "Full name as on the document"}</label>
                      <input id="kfull" value={kycForm.fullName} onChange={(e) => setKycForm((v) => ({ ...v, fullName: e.target.value }))} />
                      <div className="row">
                        <div>
                          <label htmlFor="ktype">Document</label>
                          <select id="ktype" value={account.role === "company" ? "company_registration" : kycForm.idType} onChange={(e) => setKycForm((v) => ({ ...v, idType: e.target.value }))} disabled={account.role === "company"}>
                            <option value="national_id">National ID</option>
                            <option value="passport">Passport</option>
                            <option value="company_registration">Certificate of registration</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="knum">Number</label>
                          <input id="knum" value={kycForm.idNumber} onChange={(e) => setKycForm((v) => ({ ...v, idNumber: e.target.value }))} />
                        </div>
                      </div>
                      <label htmlFor="kdoc">Photo or scan</label>
                      <input id="kdoc" ref={docRef} type="file" accept="image/*,.pdf" />
                      <button onClick={submitKyc} disabled={busy !== null || !kycForm.fullName || !kycForm.idNumber}>
                        {busy === "kyc" ? "Submitting…" : "Submit for verification"}
                      </button>
                    </>
                  )}
                </div>
              </section>
            )}

            {kinds.length > 0 && (
              <section className="panel">
                <h2><span>Post a listing</span><span>{account.kyc_status === "verified" ? "Reviewed by a trustee" : "Verify your identity first"}</span></h2>
                <div className="body">
                  <div className="row">
                    <div>
                      <label htmlFor="lid">Listing id</label>
                      <input id="lid" placeholder="ruiru-plot-12" value={listing.id} onChange={(e) => setListing((v) => ({ ...v, id: e.target.value }))} />
                    </div>
                    <div>
                      <label htmlFor="lkind">Kind</label>
                      <select id="lkind" value={listingKind} onChange={(e) => setListing((v) => ({ ...v, kind: e.target.value }))}>
                        {kinds.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
                      </select>
                    </div>
                  </div>
                  <label htmlFor="ltitle">Title</label>
                  <input id="ltitle" value={listing.title} onChange={(e) => setListing((v) => ({ ...v, title: e.target.value }))} />
                  <label htmlFor="ldesc">Description</label>
                  <textarea id="ldesc" rows={3} value={listing.description} onChange={(e) => setListing((v) => ({ ...v, description: e.target.value }))} />
                  <div className="row">
                    <div>
                      <label htmlFor="lloc">Location</label>
                      <input id="lloc" placeholder="Ruiru, Kiambu" value={listing.locationName} onChange={(e) => setListing((v) => ({ ...v, locationName: e.target.value }))} />
                    </div>
                    <div>
                      <label htmlFor="lprice">{listingKind === "property_sale" ? "Price (KES)" : "Funding target (KES)"}</label>
                      <input id="lprice" type="number" value={listing.priceKes} onChange={(e) => setListing((v) => ({ ...v, priceKes: e.target.value }))} />
                    </div>
                  </div>
                  <div className="row">
                    <div>
                      <label htmlFor="llat">Latitude</label>
                      <input id="llat" value={listing.latitude} onChange={(e) => setListing((v) => ({ ...v, latitude: e.target.value }))} />
                    </div>
                    <div>
                      <label htmlFor="llon">Longitude</label>
                      <input id="llon" value={listing.longitude} onChange={(e) => setListing((v) => ({ ...v, longitude: e.target.value }))} />
                    </div>
                  </div>
                  {listingKind !== "property_sale" && (
                    <>
                      <label htmlFor="lms">Milestones, one per line: description | stage | percent</label>
                      <textarea id="lms" rows={5} value={listing.milestones} onChange={(e) => setListing((v) => ({ ...v, milestones: e.target.value }))} />
                    </>
                  )}
                  <button onClick={postListing} disabled={busy !== null || account.kyc_status !== "verified" || !listing.id || !listing.title || !listing.priceKes}>
                    {busy === "list" ? "Recording on chain…" : "Post listing"}
                  </button>
                </div>
              </section>
            )}
          </div>

          <div>
            {account.role === "trustee" && (
              <>
                <section className="panel decide">
                  <h2><span>Projects you countersign</span><span>{view?.trustee_of.length ?? 0}</span></h2>
                  <div className="body">
                    {view?.trustee_of.length ? (
                      <table><tbody>
                        {view.trustee_of.map((p) => (
                          <tr key={p.id}><td>{p.name}</td><td className="n"><Link href={`/buy?project=${p.id}`}>review and sign →</Link></td></tr>
                        ))}
                      </tbody></table>
                    ) : <p className="empty">None yet. Approve a listing and you hold its second signature.</p>}
                  </div>
                </section>
                <ReviewPanels operator={false} selfTrusteeId={account.id} busy={busy} act={act} showToast={showToast} />
              </>
            )}

            {(view?.listings.length ?? 0) > 0 && (
              <section className="panel">
                <h2><span>Your listings</span></h2>
                <div className="body">
                  <table>
                    <thead><tr><th>Listing</th><th>Status</th><th className="n">Price</th><th className="n">Chain</th></tr></thead>
                    <tbody>
                      {view!.listings.map((l) => (
                        <tr key={l.id}>
                          <td>{l.title}{l.project_id && <> <Link href={`/?project=${l.project_id}`}>register →</Link></>}</td>
                          <td><span className="pill">{l.status.replace("_", " ")}</span>{l.note ? <div className="hint">{l.note}</div> : null}</td>
                          <td className="n">{kes(l.price_kes)}</td>
                          <td className="n"><TxLink hash={l.tx} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {account.role === "buyer" && (
              <section className="panel">
                <h2><span>Your commitments</span></h2>
                <div className="body">
                  {view?.commitments.length ? (
                    <table><tbody>
                      {view.commitments.map((c) => (
                        <tr key={c.project_id}>
                          <td>{c.name}</td>
                          <td className="n">{c.commitment ? kes(c.commitment) : "—"}</td>
                          <td className="n"><Link href={`/buy?project=${c.project_id}`}>pay in →</Link></td>
                        </tr>
                      ))}
                    </tbody></table>
                  ) : (
                    <p className="empty">Nothing yet. <Link href="/listings">Browse listings</Link> and commit to one.</p>
                  )}
                </div>
              </section>
            )}

            <ActivityFeed scope="mine" />
          </div>
        </div>
      )}

      <footer>
        <span>Custodial by design: your key is managed for you</span>
        <span><Link href="/listings">Listings</Link></span>
      </footer>
    </div>
  );
}
