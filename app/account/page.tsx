"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { AddressLink, NavLinks, TxLink } from "@/lib/ui/nav";
import { call, kes, useProject } from "@/lib/ui/project";
import { ActivityFeed, BuildRequestsPanel, ReviewPanels } from "@/lib/ui/review";

/**
 * One page for whoever you are here. Prove an email or a number, open the
 * account, then do the work of your role: add the number you pay from, pay
 * the platform fee, post what you are selling or building with photographs,
 * and wait for Datum staff to reach out and verify you. Buyers commit;
 * trustees review and countersign.
 */

interface AccountView {
  session: { subject: string; phone: string | null; email: string | null } | null;
  account: {
    id: number;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    role: string;
    display_name: string;
    company_name: string | null;
    address: string;
    kyc_status: string;
    fee_status: string;
    fee_required: boolean;
    fee_kes: number;
    registry_tx: string | null;
    registered_on_chain: boolean;
  } | null;
  fee_payment: { status: string; created_at: string; reason: string | null } | null;
  listings: Array<{ id: string; kind: string; title: string; status: string; price_kes: number; project_id: string | null; note: string | null; tx: string | null }>;
  commitments: Array<{ project_id: string; commitment: number | null; wallet: string; name: string }>;
  trustee_of: Array<{ id: string; name: string }>;
}

const ROLE_COPY: Record<string, string> = {
  buyer: "You commit to a listed home or plot and pay in instalments that sit in escrow until the work is proven.",
  sender: "You are abroad and paying for a build back home. Sign in by email, add the M-Pesa number you pay from, and every shilling sits in escrow until a trustee has signed for the work in the photographs.",
  seller: "You advertise a property that exists. Post it with photographs; Datum staff reach out to verify you, and once approved buyers pay into escrow and the money reaches you on handover.",
  developer: "You build. Post the build with its milestones and photographs; after verification, each stage you photograph and a trustee countersigns releases that stage's share to your address.",
  company: "Your company raises for a development. Post it with the funding target; after verification, buyers commit against the target and every release is signed by a trustee.",
  trustee: "You hold the second signature. You verify people, approve listings, and countersign milestones from the photographs.",
};

const EMAIL_ROLES = ["sender", "seller", "developer", "company"];
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

const STATUS_LABEL: Record<string, string> = {
  pending_review: "awaiting verification",
  live: "live",
  rejected: "not approved",
  withdrawn: "withdrawn",
};

export default function AccountPage() {
  const { toast, busy, showToast, act } = useProject();
  const [view, setView] = useState<AccountView | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  const [method, setMethod] = useState<"email" | "phone">("phone");
  const [identity, setIdentity] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [open, setOpen] = useState({ role: "buyer", displayName: "", companyName: "", registrationNumber: "" });
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const imagesRef = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState({
    id: "", kind: "", title: "", description: "", locationName: "", latitude: "-1.2921", longitude: "36.7827", priceKes: "", milestones: MILESTONE_TEMPLATE,
  });

  useEffect(() => {
    const role = new URLSearchParams(window.location.search).get("role");
    if (!role) return;
    setWanted(role);
    if (EMAIL_ROLES.includes(role)) setMethod("email");
    if (["buyer", "sender", "seller", "developer", "company"].includes(role)) setOpen((v) => ({ ...v, role }));
  }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/account", { cache: "no-store" });
    if (r.ok) setView((await r.json()) as AccountView);
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 6000);
    return () => clearInterval(id);
  }, [load]);

  const account = view?.account ?? null;
  const session = view?.session ?? null;
  const kinds = account ? (KIND_BY_ROLE[account.role] ?? []) : [];
  const listingKind = listing.kind || kinds[0] || "";
  const identityBody = () => (method === "email" ? { email: identity.trim() } : { phone: identity.trim() });

  const sendCode = () => act("otp", async () => { const r = await call("/api/auth/otp", identityBody()); setCodeSent(true); showToast(String(r.message ?? "Code sent.")); });
  const verifyCode = () => act("verify", async () => { await call("/api/auth/verify", { ...identityBody(), code: code.trim() }); setCode(""); setCodeSent(false); await load(); });
  const signOut = () => act("logout", async () => { await call("/api/auth/logout"); await load(); });

  const openAccount = () =>
    act("open", async () => {
      const r = await call("/api/account", { ...open, companyName: open.companyName || undefined, registrationNumber: open.registrationNumber || undefined });
      showToast(String(r.message));
      await load();
    });

  const sendEmailCode = () => act("email", async () => { const r = await call("/api/account/email", { email: newEmail.trim() }); setEmailCodeSent(true); showToast(String(r.message)); });
  const verifyEmail = () => act("emailverify", async () => { const r = await call("/api/account/email/verify", { email: newEmail.trim(), code: emailCode.trim() }); showToast(String(r.message)); setEmailCodeSent(false); setEmailCode(""); setNewEmail(""); await load(); });
  const savePhone = () => act("phone", async () => { const r = await call("/api/account/phone", { phone: newPhone.trim() }); showToast(String(r.message)); await load(); });
  const payFee = () => act("fee", async () => { const r = await call("/api/account/fee"); showToast(String(r.message)); await load(); });

  const postListing = () =>
    act("list", async () => {
      const files = imagesRef.current?.files;
      if (!files?.length) { showToast("Attach at least one photograph.", true); return; }
      const form = new FormData();
      form.append("id", listing.id.trim());
      form.append("kind", listingKind);
      form.append("title", listing.title.trim());
      form.append("description", listing.description.trim());
      form.append("locationName", listing.locationName.trim());
      form.append("latitude", listing.latitude);
      form.append("longitude", listing.longitude);
      form.append("priceKes", listing.priceKes);
      if (listingKind !== "property_sale") {
        const milestones = listing.milestones.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
          const [description = "", stage = "", percent = ""] = line.split("|").map((s) => s.trim());
          return { description, stage, percent: Number.parseInt(percent, 10) };
        });
        form.append("milestones", JSON.stringify(milestones));
      }
      for (const f of files) form.append("images", f);
      const r = await call("/api/listings", form);
      showToast(String(r.message));
      setListing((v) => ({ ...v, id: "", title: "", description: "", priceKes: "" }));
      if (imagesRef.current) imagesRef.current.value = "";
      await load();
    });

  const feeState = account ? (account.fee_status === "paid" ? "paid" : view?.fee_payment?.status === "pending" || account.fee_status === "pending" ? "waiting" : "due") : "";
  const needsPhone = !!account && !account.phone;
  const canPost = !!account && !account.fee_required && !needsPhone;
  const identityLine = account ? (account.role === "trustee" ? "appointed by the platform" : account.kyc_status === "verified" ? "verified by Datum staff" : view?.listings.some((l) => l.status === "pending_review") ? "staff will reach out to you" : "after you post") : "";

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>{account ? account.display_name : "Your account"}</h1>
        <div className="meta">
          <NavLinks current="account" />
          {account && <span>Role <b>{account.role}</b></span>}
          {account && <span>Verification <b>{identityLine}</b></span>}
          {session && (
            <span>
              <b>{session.subject}</b>{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>sign out</a>
            </span>
          )}
        </div>
      </header>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}

      {!session && (
        <div className="cols">
          <section className="panel">
            <h2>
              <span>{wanted ? `Continue as ${wanted === "trustee" ? "a trustee" : wanted === "operator" ? "the operator" : `a ${wanted}`}` : "Sign in"}</span>
              <span>One-time code</span>
            </h2>
            <div className="body">
              {wanted === "trustee" ? (
                <p>Trustees are appointed by the platform. Sign in with the number you were appointed on and your desk opens; if you have not been appointed, ask the operator.</p>
              ) : (
                <p>Buyers sign in with the M-Pesa number they pay from. Sellers, developers, companies and anyone sending money from abroad sign in by email and add a number afterwards.</p>
              )}
              <div className="btns" style={{ marginBottom: 12 }}>
                <button className={method === "email" ? "" : "ghost"} onClick={() => { setMethod("email"); setCodeSent(false); }} disabled={busy !== null}>Email</button>
                <button className={method === "phone" ? "" : "ghost"} onClick={() => { setMethod("phone"); setCodeSent(false); }} disabled={busy !== null}>M-Pesa number</button>
              </div>
              <div className="row">
                <div>
                  <label htmlFor="identity">{method === "email" ? "Email address" : "M-Pesa number"}</label>
                  <input id="identity" type={method === "email" ? "email" : "tel"} placeholder={method === "email" ? "you@example.com" : "07XX XXX XXX"} value={identity} onChange={(e) => setIdentity(e.target.value)} disabled={codeSent} />
                </div>
                {codeSent && (
                  <div>
                    <label htmlFor="code">Code</label>
                    <input id="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
                  </div>
                )}
              </div>
              <div className="btns">
                {codeSent ? (
                  <>
                    <button onClick={verifyCode} disabled={busy !== null || code.length !== 6}>Verify</button>
                    <button className="ghost" onClick={() => setCodeSent(false)} disabled={busy !== null}>Change</button>
                  </>
                ) : (
                  <button onClick={sendCode} disabled={busy !== null || !identity.trim()}>{busy === "otp" ? "Sending…" : "Send me a code"}</button>
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

      {session && !account && (
        <div className="cols">
          <section className="panel">
            <h2><span>Open your account</span><span>{session.subject}</span></h2>
            <div className="body">
              <p>Choose what you are here to do. The role is chosen once, and an Avalanche address is created for you the moment the account opens.</p>
              <label htmlFor="role">I am</label>
              <select id="role" value={open.role} onChange={(e) => setOpen((v) => ({ ...v, role: e.target.value }))}>
                <option value="buyer">A buyer</option>
                <option value="sender">Sending money home for a build</option>
                <option value="seller">A seller of an existing property</option>
                <option value="developer">A developer or builder</option>
                <option value="company">A company</option>
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
                    <tr><td>Registered on chain</td><td className="n">{account.registry_tx ? <TxLink hash={account.registry_tx} /> : account.registered_on_chain ? "yes" : <span className="held-c">pending</span>}</td></tr>
                    {account.email && <tr><td>Email</td><td className="n">{account.email} {account.email_verified ? <span className="sig">proven</span> : <span className="held-c">not yet proven</span>}</td></tr>}
                    <tr><td>M-Pesa number</td><td className="n">{account.phone ? <>{account.phone} {account.phone_verified ? <span className="sig">proven</span> : <span className="held-c">not yet proven</span>}</> : "—"}</td></tr>
                    {(account.fee_required || account.fee_status === "paid") && <tr><td>Platform fee</td><td className="n">{feeState === "paid" ? <span className="sig">paid</span> : feeState === "waiting" ? <span className="held-c">waiting for M-Pesa</span> : kes(account.fee_kes) + " due"}</td></tr>}
                    <tr><td>Verification</td><td className="n">{identityLine}</td></tr>
                  </tbody>
                </table>
                <p className="hint" style={{ marginTop: 12 }}>
                  Everything you do here is written against this address. <Link href={`/trace/${account.address}`}>Trace every activity at it →</Link>
                </p>
              </div>
            </section>

            {!account.email_verified && (
              <section className="panel">
                <h2><span>{account.email ? "Confirm your email" : "Add your email"}</span><span>Code by email</span></h2>
                <div className="body">
                  <p>{account.email ? `${account.email} was given as contact detail. Confirm it and staff and receipts reach you there.` : "An email on your profile means staff and receipts reach you there, and you can sign in by email as well as by number."}</p>
                  <div className="row">
                    <div>
                      <label htmlFor="newemail">Email address</label>
                      <input id="newemail" type="email" placeholder={account.email ?? "you@example.com"} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} disabled={emailCodeSent} />
                    </div>
                    {emailCodeSent && (
                      <div>
                        <label htmlFor="emailcode">Code</label>
                        <input id="emailcode" inputMode="numeric" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} />
                      </div>
                    )}
                  </div>
                  <div className="btns">
                    {emailCodeSent ? (
                      <>
                        <button onClick={verifyEmail} disabled={busy !== null || emailCode.length !== 6}>Confirm</button>
                        <button className="ghost" onClick={() => setEmailCodeSent(false)} disabled={busy !== null}>Change</button>
                      </>
                    ) : (
                      <button className="ghost" onClick={sendEmailCode} disabled={busy !== null || !newEmail.trim()}>{busy === "email" ? "Sending…" : "Send me a code"}</button>
                    )}
                  </div>
                </div>
              </section>
            )}

            {needsPhone && (
              <section className="panel decide">
                <h2><span>1 — The number you pay from</span><span>M-Pesa</span></h2>
                <div className="body">
                  <p>The fee and every instalment are M-Pesa prompts to this number. It is proven the moment the fee arrives from it.</p>
                  <label htmlFor="newphone">M-Pesa number</label>
                  <input id="newphone" type="tel" placeholder="07XX XXX XXX" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                  <button onClick={savePhone} disabled={busy !== null || !newPhone.trim()}>Save number</button>
                </div>
              </section>
            )}

            {account.fee_required && !needsPhone && (
              <section className="panel decide">
                <h2><span>{account.email ? "2 — " : ""}Platform fee</span><span>{kes(account.fee_kes)}</span></h2>
                <div className="body">
                  <p>
                    {account.role === "sender"
                      ? "A one-off fee before you can commit to a build. It pays for the trustee who signs for the work."
                      : "A one-off fee before you can post. It pays for the staff visit that verifies you and your listing."}
                  </p>
                  {feeState === "waiting" ? (
                    <p className="hint">Prompt sent to {account.phone}. Approve it on the handset; this page updates on its own once Safaricom confirms.</p>
                  ) : null}
                  {view?.fee_payment?.status === "failed" && <div className="toast err">The last prompt was not paid{view.fee_payment.reason ? `: ${view.fee_payment.reason}` : ""}. Try again.</div>}
                  <button onClick={payFee} disabled={busy !== null}>{busy === "fee" ? "Sending prompt…" : feeState === "waiting" ? "Send the prompt again" : `Pay ${kes(account.fee_kes)} by M-Pesa`}</button>
                </div>
              </section>
            )}

            {kinds.length > 0 && (
              <section className="panel">
                <h2><span>{account.email ? "3 — " : ""}Post what you are {account.role === "seller" ? "selling" : "building"}</span><span>{canPost ? "Staff verify after you post" : "Pay the fee first"}</span></h2>
                <div className="body">
                  <p>Post it with photographs. Datum staff reach out to you at {account.email ?? account.phone} to verify you and what you posted, and it goes live once they approve.</p>
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
                  <label htmlFor="limgs">Photographs (up to six)</label>
                  <input id="limgs" ref={imagesRef} type="file" accept="image/*" multiple />
                  <button onClick={postListing} disabled={busy !== null || !canPost || !listing.id || !listing.title || !listing.priceKes}>
                    {busy === "list" ? "Uploading…" : "Post for verification"}
                  </button>
                </div>
              </section>
            )}

            {account.role === "sender" && canPost && (
              <section className="panel">
                <h2><span>3 — Choose the build</span></h2>
                <div className="body">
                  <p>Fee paid and number proven. Pick the build from the listings, commit, and pay in instalments; the pay-in page shows every photograph before a trustee signs.</p>
                  <Link className="btn" href="/listings">Browse listings</Link>
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
                <BuildRequestsPanel operator={false} selfTrusteeId={account.id} busy={busy} act={act} showToast={showToast} />
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
                          <td>{l.title}{l.project_id && <> <Link href={`/register?project=${l.project_id}`}>register →</Link></>}</td>
                          <td><span className="pill">{STATUS_LABEL[l.status] ?? l.status}</span>{l.note ? <div className="hint">{l.note}</div> : null}</td>
                          <td className="n">{kes(l.price_kes)}</td>
                          <td className="n"><TxLink hash={l.tx} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {view!.listings.some((l) => l.status === "pending_review") && (
                    <p className="hint">Datum staff will contact you at {account.email ?? account.phone} to verify before anything goes live.</p>
                  )}
                </div>
              </section>
            )}

            {["buyer", "sender", "developer", "company"].includes(account.role) && (
              <section className="panel">
                <h2><span>{account.role === "developer" || account.role === "company" ? "Builds assigned to you" : "Build my house"}</span></h2>
                <div className="body">
                  <p>
                    {account.role === "developer" || account.role === "company"
                      ? "When Datum assigns you to an owner's build, the agreement appears on the build page for you to sign. The second signature deploys the escrow."
                      : "Ask Datum to build on your plot: a ten percent deposit, a verified builder, a trustee, and an agreement you both sign before any escrow exists."}
                  </p>
                  <Link className="btn ghost" href="/build">Open the build page</Link>
                </div>
              </section>
            )}

            {(account.role === "buyer" || account.role === "sender") && (
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
