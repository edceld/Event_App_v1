"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  languages,
  languageNames,
  translate,
  detectLanguage,
  type Language,
} from "@/lib/i18n";
import { ticketJpg } from "@/lib/jpg";
import { BETA_VERSION } from "@/lib/release";
import type { User } from "@/lib/auth";
type EventRow = {
  id: string;
  name: string;
  starts_at: string;
  venue: string;
  capacity: number;
  issued: number;
  arrived: number;
};
type Ticket = {
  id: string;
  name: string;
  email?: string;
  category: string;
  cancelled: number;
  checked_in_at: string | null;
};
type RequestRow = {
  id: string;
  name: string;
  category: string;
  status: string;
  cancelled: number;
  created_at: string;
  requested_by_name: string;
  supervisor_name?: string;
  resolved_at?: string;
  reason?: string;
};
type ScanResult = { status: string; ticket?: Ticket };
async function api(path: string, body?: unknown) {
  const r = await fetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (r.status === 401 && path !== "login" && path !== "me")
    window.dispatchEvent(new Event("event-gate-session-expired"));
  if (!r.ok) throw new Error(data.error || "error");
  return data;
}
export default function Home() {
  const [lang, setLang] = useState<Language>("en");
  const t = useCallback((key: string) => translate(lang, key), [lang]);
  const releaseLabel = t("betaVersion").replace(
    "{version}",
    String(BETA_VERSION),
  );
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [emailEnabled, setEmailEnabled] = useState(false);
  const [events, setEvents] = useState<EventRow[]>([]),
    [eventId, setEventId] = useState("");
  const currentEvent = useRef(eventId),
    currentUser = useRef(user?.id);
  currentEvent.current = eventId;
  currentUser.current = user?.id;
  const [tab, setTab] = useState("scan"),
    [tickets, setTickets] = useState<Ticket[]>([]),
    [requests, setRequests] = useState<RequestRow[]>([]),
    [team, setTeam] = useState<User[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(""),
    [search, setSearch] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null),
    [qrText, setQrText] = useState(""),
    [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    controls = useRef<{ stop: () => void } | null>(null),
    scanning = useRef(false),
    cameraGeneration = useRef(0);
  const [preview, setPreview] = useState<{
    image: string;
    ticket: Ticket;
  } | null>(null);
  const selected = events.find((e) => e.id === eventId);
  const isAdmin = user?.role === "admin";
  useEffect(() => {
    const expire = () => {
      setUser(null);
      setEventId("");
      setEvents([]);
      setTickets([]);
      setRequests([]);
      setTeam([]);
      setPreview(null);
      setModal("");
      setTab("scan");
      setError("UNAUTHORIZED");
    };
    window.addEventListener("event-gate-session-expired", expire);
    return () =>
      window.removeEventListener("event-gate-session-expired", expire);
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem("event-gate-language");
    setLang(
      languages.includes(saved as Language)
        ? (saved as Language)
        : detectLanguage(navigator.language),
    );
    api("me")
      .then((d) => {
        setUser(d.user);
        setEmailEnabled(d.emailEnabled);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem("event-gate-language", lang);
  }, [lang]);
  const refresh = useCallback(async () => {
    if (!user) return;
    const e = await api("events");
    if (currentUser.current !== user.id) return;
    setEvents(e);
    if (e.length) setEventId((current) => current || e[0].id);
    if (eventId) {
      const r = await api(`requests?eventId=${encodeURIComponent(eventId)}`);
      if (currentUser.current !== user.id || currentEvent.current !== eventId)
        return;
      setRequests(r);
      if (user.role === "admin") {
        const result = await api(
          `tickets?eventId=${encodeURIComponent(eventId)}`,
        );
        if (currentUser.current === user.id && currentEvent.current === eventId)
          setTickets(result);
      }
    }
    if (user.role === "admin" && tab === "team") setTeam(await api("users"));
  }, [user, eventId, tab]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    if (!user) return;
    const timer = setInterval(() => {
      refresh().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, user]);
  function stopCamera() {
    cameraGeneration.current++;
    controls.current?.stop();
    controls.current = null;
    setCamera(false);
  }
  useEffect(
    () => () => {
      cameraGeneration.current++;
      controls.current?.stop();
      controls.current = null;
    },
    [eventId, tab, user],
  );
  useEffect(() => {
    setScan(null);
    setCamera(false);
  }, [eventId, tab]);
  useEffect(() => {
    setTickets([]);
    setRequests([]);
    setPreview(null);
    setModal("");
    setQrText("");
  }, [eventId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }
  async function check(qr: string) {
    if (scanning.current) return;
    scanning.current = true;
    stopCamera();
    await action(async () => {
      const result = await api("scan", { eventId, qr });
      if (currentEvent.current === eventId) setScan(result);
      await refresh();
    });
    scanning.current = false;
  }
  async function startCamera() {
    setError("");
    setScan(null);
    setCamera(true);
    const generation = ++cameraGeneration.current;
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (generation !== cameraGeneration.current) return;
      const reader = new BrowserQRCodeReader();
      const active = await reader.decodeFromConstraints(
        {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
          },
          audio: false,
        },
        video.current!,
        (result) => {
          if (
            result &&
            generation === cameraGeneration.current &&
            !scanning.current
          ) {
            void check(result.getText());
          }
        },
      );
      if (generation !== cameraGeneration.current) active.stop();
      else controls.current = active;
    } catch {
      if (generation === cameraGeneration.current) {
        setCamera(false);
        setError("cameraError");
      }
    }
  }
  async function exportTicket(ticket: Ticket) {
    const { qr } = await api("ticket-export", { ticketId: ticket.id });
    const image = await ticketJpg(selected!, ticket, qr, lang);
    setPreview({ image, ticket });
  }
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  const languageSelect = (
    <label className="language">
      <span aria-hidden="true">◎</span>
      <select
        aria-label="Language / 言語"
        value={lang}
        onChange={(e) => setLang(e.target.value as Language)}
      >
        {languages.map((l, i) => (
          <option key={l} value={l}>
            {languageNames[i]}
          </option>
        ))}
      </select>
    </label>
  );
  if (loading) return <main className="loading">{t("loading")}</main>;
  if (!user)
    return (
      <div className="login-layout">
        <section className="welcome">
          <a className="brand" href="/">
            ◈ <span>EVENT GATE</span>
          </a>
          <div>
            <span className="eyebrow">TICKETS · CHECK-IN · WELCOME</span>
            <h1>{t("tagline")}</h1>
            <div className="ticket-art" aria-hidden="true">
              <span>EVENT GATE</span>
              <div className="art-qr">▦</div>
              <div>ADMIT ONE</div>
              <i>• • • • • • • • • • • • • •</i>
            </div>
          </div>
          <p>{t("online")}</p>
        </section>
        <section className="login-side">
          {languageSelect}
          <form
            className="login-card"
            onSubmit={(e) => {
              const d = form(e);
              void action(async () => {
                await api("login", d);
                const me = await api("me");
                setUser(me.user);
                setEmailEnabled(me.emailEnabled);
              });
            }}
          >
            <span className="eyebrow">EVENT GATE · {releaseLabel}</span>
            <h2>{t("login")}</h2>
            <p className="muted">{t("loginHelp")}</p>
            <label>
              {t("email")}
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
                maxLength={254}
              />
            </label>
            <label>
              {t("password")}
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            {error && (
              <p className="alert error" role="alert">
                {t(error)}
              </p>
            )}
            <button disabled={busy}>
              {busy ? t("loading") : t("login")} <span>→</span>
            </button>
          </form>
        </section>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          ◈ <span>EVENT GATE</span>
        </a>
        <p className="eyebrow">{t("event")}</p>
        <label className="event-picker">
          <span className="sr-only">{t("event")}</span>
          <select
            value={eventId}
            onChange={(e) => {
              stopCamera();
              setEventId(e.target.value);
            }}
          >
            <option value="" disabled>
              —
            </option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <nav>
          {[
            "scan",
            ...(isAdmin ? ["tickets"] : []),
            "approvals",
            ...(isAdmin ? ["team"] : []),
          ].map((k, i) => (
            <button
              className={tab === k ? "nav active" : "nav"}
              key={k}
              onClick={() => {
                stopCamera();
                setTab(k);
                setError("");
                setNotice("");
              }}
            >
              <span aria-hidden="true">
                {["⌗", "◇", "↺", "♙"][isAdmin ? i : k === "scan" ? 0 : 2]}
              </span>
              {t(k)}
              {k === "approvals" &&
                requests.some((r) => r.status === "pending") && (
                  <i className="dot" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{t(user.role)}</small>
          </div>
          <button
            className="icon-btn"
            title={t("logout")}
            aria-label={t("logout")}
            onClick={() =>
              void action(async () => {
                stopCamera();
                await api("logout", {});
                setUser(null);
                setEvents([]);
                setEventId("");
                setTickets([]);
                setRequests([]);
                setTeam([]);
                setPreview(null);
                setTab("scan");
              })
            }
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <span className="eyebrow">
              EVENT GATE / {t(tab)} · {releaseLabel}
            </span>
            <h1>{selected?.name || t("events")}</h1>
            {selected && (
              <p className="muted">
                {new Date(selected.starts_at).toLocaleString(lang)}{" "}
                <span className="separator">·</span> {selected.venue}
              </p>
            )}
          </div>
          <div className="header-actions">
            {languageSelect}
            {isAdmin && (
              <button className="secondary" onClick={() => setModal("event")}>
                ＋ {t("newEvent")}
              </button>
            )}
          </div>
        </header>
        {error && (
          <p className="alert error" role="alert">
            {t(error)}
          </p>
        )}
        {notice && (
          <p className="alert success" role="status">
            {t(notice)}
          </p>
        )}
        {selected ? (
          <>
            <section className="stats" aria-label={t("event")}>
              <article>
                <span>{t("issued")}</span>
                <strong>
                  {selected.issued}
                  <small> / {selected.capacity}</small>
                </strong>
                <div className="meter">
                  <i
                    style={{
                      width: `${(selected.issued / selected.capacity) * 100}%`,
                    }}
                  />
                </div>
              </article>
              <article>
                <span>{t("arrived")}</span>
                <strong>{selected.arrived}</strong>
                <small>{t("online")}</small>
              </article>
              <article>
                <span>{t("remaining")}</span>
                <strong>{selected.capacity - selected.issued}</strong>
                <small>{t("capacity")}</small>
              </article>
            </section>
            {tab === "scan" && (
              <section className="scan-layout">
                <article className="panel scan-panel">
                  <div className="panel-heading">
                    <span className="eyebrow">{t("scan")}</span>
                    <span className="live">
                      <i />
                      {t("online")}
                    </span>
                  </div>
                  <h2>{t("scanTitle")}</h2>
                  <p className="muted">{t("scanHelp")}</p>
                  <div className={`viewfinder ${camera ? "on" : ""}`}>
                    <video
                      ref={video}
                      muted
                      playsInline
                      autoPlay
                      hidden={!camera}
                    />
                    {!camera && (
                      <div aria-hidden="true" className="scan-symbol">
                        ⌗
                      </div>
                    )}
                    <span className="corner tl" />
                    <span className="corner tr" />
                    <span className="corner bl" />
                    <span className="corner br" />
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => (camera ? stopCamera() : void startCamera())}
                  >
                    {t(camera ? "stop" : "camera")}
                  </button>
                  <form
                    className="manual"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void check(qrText);
                    }}
                  >
                    <label>
                      {t("manual")}
                      <div className="input-group">
                        <input
                          value={qrText}
                          onChange={(e) => setQrText(e.target.value)}
                          placeholder="EG1:…"
                          autoComplete="off"
                          required
                          maxLength={100}
                        />
                        <button className="secondary" disabled={busy}>
                          {t("verify")}
                        </button>
                      </div>
                    </label>
                  </form>
                </article>
                <article
                  className={`panel result-panel ${scan?.status || ""}`}
                  aria-live="polite"
                >
                  {scan ? (
                    <>
                      <span className="result-icon">
                        {scan.status === "admitted"
                          ? "✓"
                          : scan.status === "duplicate"
                            ? "↺"
                            : "!"}
                      </span>
                      <h2>{t(scan.status)}</h2>
                      {scan.ticket && (
                        <>
                          <h3>{scan.ticket.name}</h3>
                          <span className={`badge ${scan.ticket.category}`}>
                            {t(scan.ticket.category)}
                          </span>
                          <p className="muted">
                            {t("firstEntry")}
                            <br />
                            {scan.ticket.checked_in_at &&
                              new Date(
                                scan.ticket.checked_in_at,
                              ).toLocaleString(lang)}
                          </p>
                        </>
                      )}
                      {scan.status === "duplicate" && (
                        <>
                          <p>{t("duplicateHelp")}</p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await api("reentry", {
                                  ticketId: scan.ticket!.id,
                                });
                                setNotice("requested");
                                await refresh();
                              })
                            }
                          >
                            {t("request")}
                          </button>
                        </>
                      )}
                      <button
                        className="secondary"
                        onClick={() => {
                          setScan(null);
                          setQrText("");
                          setNotice("");
                        }}
                      >
                        {t("next")}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="result-icon neutral">✓</span>
                      <h2>{t("scanTitle")}</h2>
                      <p className="muted">{t("scanHelp")}</p>
                      <div className="mini-types">
                        {["staff", "performer", "general"].map((k) => (
                          <span className={`badge ${k}`} key={k}>
                            {t(k)}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </article>
              </section>
            )}
            {tab === "tickets" && isAdmin && (
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>{t("tickets")}</h2>
                    <p className="muted">{t("paid")}</p>
                  </div>
                  <button
                    disabled={selected.issued >= selected.capacity}
                    onClick={() => setModal("ticket")}
                  >
                    ＋ {t("issue")}
                  </button>
                </div>
                <label className="search">
                  <span className="sr-only">{t("search")}</span>
                  <input
                    placeholder={t("search")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="ticket-list">
                  {tickets
                    .filter((x) =>
                      `${x.name} ${x.email || ""}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((ticket) => (
                      <article className="ticket-row" key={ticket.id}>
                        <div className="ticket-person">
                          <span className="avatar light">
                            {ticket.name.slice(0, 1)}
                          </span>
                          <div>
                            <strong>{ticket.name}</strong>
                            <small>
                              {ticket.email ||
                                ticket.id.slice(0, 8).toUpperCase()}
                            </small>
                          </div>
                        </div>
                        <span className={`badge ${ticket.category}`}>
                          {t(ticket.category)}
                        </span>
                        <small>
                          {ticket.cancelled
                            ? t("cancelled")
                            : ticket.checked_in_at
                              ? t("arrived")
                              : "—"}
                        </small>
                        <div className="row-actions">
                          <button
                            className="secondary"
                            disabled={busy || !!ticket.cancelled}
                            onClick={() =>
                              void action(() => exportTicket(ticket))
                            }
                          >
                            {t("download")}
                          </button>
                          <button
                            className="text-btn danger"
                            disabled={busy || !!ticket.cancelled}
                            onClick={() => {
                              if (confirm(t("cancelConfirm")))
                                void action(async () => {
                                  await api("cancel", { ticketId: ticket.id });
                                  await refresh();
                                });
                            }}
                          >
                            {t("cancel")}
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
                {!tickets.length && <p className="empty">{t("noTickets")}</p>}
                <p className="fineprint">{t("privacy")}</p>
              </section>
            )}
            {tab === "approvals" && (
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>{t("approvals")}</h2>
                    <p className="muted">{t("roleHelp")}</p>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void action(refresh)}
                  >
                    {t("refresh")}
                  </button>
                </div>
                <div className="request-list">
                  {requests.map((r) => (
                    <article key={r.id} className="request-card">
                      <div className="section-heading">
                        <div>
                          <h3>{r.name}</h3>
                          <span className={`badge ${r.category}`}>
                            {t(r.category)}
                          </span>
                        </div>
                        <span className={`status ${r.status}`}>
                          {t(r.status)}
                        </span>
                      </div>
                      <p className="muted">
                        {t("requestedBy")}: {r.requested_by_name} ·{" "}
                        {new Date(r.created_at).toLocaleString(lang)}
                      </p>
                      {r.supervisor_name && (
                        <p>
                          {t("supervisorBy")}: {r.supervisor_name} ·{" "}
                          {r.resolved_at &&
                            new Date(r.resolved_at).toLocaleString(lang)}
                        </p>
                      )}
                      {r.reason && <p>{r.reason}</p>}
                      {r.cancelled ? (
                        <p className="alert error">{t("cancelled")}</p>
                      ) : (
                        r.status === "pending" &&
                        user.role !== "checkin" && (
                          <form
                            onSubmit={(e) => {
                              const d = form(e);
                              void action(async () => {
                                await api("resolve", {
                                  requestId: r.id,
                                  approve: true,
                                  reason: d.reason,
                                });
                                await refresh();
                              });
                            }}
                          >
                            <label>
                              <span className="sr-only">{t("reason")}</span>
                              <input
                                name="reason"
                                placeholder={t("reason")}
                                maxLength={500}
                              />
                            </label>
                            <div className="row-actions">
                              <button disabled={busy}>{t("approve")}</button>
                              <button
                                className="secondary"
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await api("resolve", {
                                      requestId: r.id,
                                      approve: false,
                                    });
                                    await refresh();
                                  })
                                }
                              >
                                {t("reject")}
                              </button>
                            </div>
                          </form>
                        )
                      )}
                    </article>
                  ))}
                </div>
                {!requests.length && <p className="empty">{t("noRequests")}</p>}
              </section>
            )}
            {tab === "team" && isAdmin && (
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>{t("team")}</h2>
                    <p className="muted">{t("roleHelp")}</p>
                  </div>
                  <button onClick={() => setModal("user")}>
                    ＋ {t("addUser")}
                  </button>
                </div>
                {team.map((u) => (
                  <article className="ticket-row" key={u.id}>
                    <div className="ticket-person">
                      <span className="avatar light">{u.name.slice(0, 1)}</span>
                      <div>
                        <strong>{u.name}</strong>
                        <small>{u.email}</small>
                      </div>
                    </div>
                    <span className="badge">{t(u.role)}</span>
                  </article>
                ))}
              </section>
            )}
          </>
        ) : (
          <section className="panel empty">
            <h2>{t(isAdmin ? "noEvents" : "noStaffEvents")}</h2>
            {isAdmin && (
              <button onClick={() => setModal("event")}>
                ＋ {t("newEvent")}
              </button>
            )}
          </section>
        )}
        <footer>
          ◈ EVENT GATE · {releaseLabel} <span>{t("online")}</span>
        </footer>
      </main>
      {modal && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close icon-btn"
              aria-label={t("close")}
              onClick={() => setModal("")}
            >
              ×
            </button>
            <h2 id="modal-title">
              {t(
                modal === "event"
                  ? "newEvent"
                  : modal === "ticket"
                    ? "issue"
                    : "addUser",
              )}
            </h2>
            {error && (
              <p className="alert error" role="alert">
                {t(error)}
              </p>
            )}
            {modal === "event" && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void action(async () => {
                    const result = await api("events", {
                      ...d,
                      capacity: Number(d.capacity),
                      startsAt: new Date(String(d.startsAt)).toISOString(),
                    });
                    setEventId(result.id);
                    setModal("");
                    await refresh();
                  });
                }}
              >
                <label>
                  {t("eventName")}
                  <input name="name" required maxLength={160} autoFocus />
                </label>
                <label>
                  {t("date")}
                  <input type="datetime-local" name="startsAt" required />
                </label>
                <label>
                  {t("venue")}
                  <input name="venue" required maxLength={200} />
                </label>
                <label>
                  {t("capacity")}
                  <input
                    type="number"
                    name="capacity"
                    min={1}
                    max={100000}
                    defaultValue={120}
                    required
                  />
                  <small>{t("capacityHelp")}</small>
                </label>
                <button disabled={busy}>{t("create")}</button>
              </form>
            )}
            {modal === "ticket" && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void action(async () => {
                    const result = await api("tickets", { ...d, eventId });
                    await refresh();
                    setModal("");
                    await exportTicket({
                      id: result.id,
                      name: String(d.name),
                      email: String(d.email),
                      category: String(d.category),
                      cancelled: 0,
                      checked_in_at: null,
                    });
                  });
                }}
              >
                <p className="muted">{t("paid")}</p>
                <label>
                  {t("name")}
                  <input name="name" required maxLength={120} autoFocus />
                </label>
                <label>
                  {t("email")} · {t("optional")}
                  <input type="email" name="email" maxLength={254} />
                </label>
                <label>
                  {t("category")}
                  <select name="category" defaultValue="general">
                    {["staff", "performer", "general"].map((k) => (
                      <option key={k} value={k}>
                        {t(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy}>{t("issue")}</button>
              </form>
            )}
            {modal === "user" && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void action(async () => {
                    await api("users", d);
                    setModal("");
                    await refresh();
                  });
                }}
              >
                <label>
                  {t("name")}
                  <input name="name" required maxLength={120} autoFocus />
                </label>
                <label>
                  {t("email")}
                  <input name="email" type="email" required maxLength={254} />
                </label>
                <label>
                  {t("role")}
                  <select name="role" defaultValue="checkin">
                    {["checkin", "supervisor", "admin"].map((k) => (
                      <option value={k} key={k}>
                        {t(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("password")}
                  <input
                    type="password"
                    name="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                  <small>{t("passwordHelp")}</small>
                </label>
                <button disabled={busy}>{t("create")}</button>
              </form>
            )}
          </section>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section
            className="modal preview"
            role="dialog"
            aria-modal="true"
            aria-label={t("tickets")}
          >
            <button
              className="modal-close icon-btn"
              aria-label={t("close")}
              onClick={() => setPreview(null)}
            >
              ×
            </button>
            <img
              src={preview.image}
              alt={`${preview.ticket.name} — ${t(preview.ticket.category)}`}
            />
            <a
              className="button"
              download={`ticket-${preview.ticket.id.slice(0, 8)}.jpg`}
              href={preview.image}
            >
              {t("download")} ↓
            </a>
            <button
              className="secondary"
              disabled={busy || !emailEnabled || !preview.ticket.email}
              onClick={() =>
                void action(async () => {
                  await api("email", {
                    ticketId: preview.ticket.id,
                    image: preview.image,
                  });
                  setNotice("sent");
                })
              }
            >
              {t("send")}
            </button>
            {!emailEnabled && <p className="muted">{t("emailSetup")}</p>}
            {error && (
              <p className="alert error" role="alert">
                {t(error)}
              </p>
            )}
            {notice === "sent" && (
              <p className="alert success" role="status">
                {t("sent")}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
