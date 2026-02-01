import { useState, useEffect, useRef, useCallback } from "react";

// ─── Color palette built around sky-blue ────────────────────
const BG = "#7EC8E3";            // sky-blue base
const BG_DEEP = "#5BA3C9";       // deeper sky for ring track & depth
const FOCUS_COLOR = "#1B3A5C";   // deep navy – dominant accent
const SHORT_COLOR = "#2E7D4F";   // forest green
const LONG_COLOR  = "#E8943A";   // warm orange
const TEXT_DARK   = "#0F2137";   // near-black for primary text
const TEXT_MID    = "#2A5070";   // mid-tone labels
const TEXT_LIGHT  = "#4A7A9B";   // secondary / inactive
const CARD_BG     = "rgba(255,255,255,0.22)";
const CARD_BORDER = "rgba(255,255,255,0.35)";

const MODES = {
  focus: { label: "FOCUS",        duration: 25 * 60, color: FOCUS_COLOR },
  short: { label: "SHORT BREAK",  duration:  5 * 60, color: SHORT_COLOR },
  long:  { label: "LONG BREAK",   duration: 15 * 60, color: LONG_COLOR  },
};

// ─── Audio helpers ──────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;

// Synthesise a warm bell strike: attack + two harmonics + slow decay
function strikeBell(ctx) {
  const now = ctx.currentTime;
  [1, 2, 3].forEach((harmonic, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(440 * harmonic, now);
    // each harmonic quieter & shorter
    const vol = [0.22, 0.12, 0.06][i];
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.8 - i * 0.4);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(now);
    o.stop(now + 2);
  });
}

// Bell manager – returns { start, stop }
// start() rings once immediately then every 4 s for up to 60 s
// stop()  cancels everything immediately
function createBellManager() {
  let ctx = null;
  let intervalId = null;
  let timeoutId  = null;   // auto-stop after 60 s

  function ensureCtx() {
    if (!ctx || ctx.state === "closed") ctx = new AudioCtx();
    if (ctx.state === "suspended") ctx.resume();
  }

  function start() {
    ensureCtx();
    strikeBell(ctx);                          // play immediately
    intervalId = setInterval(() => {
      ensureCtx();
      strikeBell(ctx);
    }, 4000);                                 // repeat every 4 s
    timeoutId = setTimeout(stop, 60000);      // auto-cancel after 60 s
  }

  function stop() {
    clearInterval(intervalId);
    clearTimeout(timeoutId);
    intervalId = null;
    timeoutId  = null;
  }

  return { start, stop };
}

const bell = createBellManager();

// ─── Daily session helpers (persistent via window.storage) ──
function todayKey() {
  const d = new Date();
  return `pomodoro:${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

async function loadTodaySessions() {
  try {
    const res = await window.storage.get(todayKey());
    return res ? Number(res.value) : 0;
  } catch { return 0; }
}

async function saveTodaySessions(n) {
  try { await window.storage.set(todayKey(), String(n)); } catch {}
}

// ─── Main component ─────────────────────────────────────────
export default function PomodoroTimer() {
  const [mode, setMode]           = useState("focus");
  const [timeLeft, setTimeLeft]   = useState(MODES.focus.duration);
  const [running, setRunning]     = useState(false);
  const [sessions, setSessions]   = useState(0);
  const [dailySessions, setDaily] = useState(0);
  const [loaded, setLoaded]       = useState(false);
  const [bellActive, setBellActive] = useState(false);
  const [alertMsg, setAlertMsg]     = useState("");
  const intervalRef      = useRef(null);
  const startedAtRef     = useRef(null);   // Date.now() when (re-)started
  const remainingAtStart = useRef(null);   // timeLeft snapshot when (re-)started
  const modeRef          = useRef(mode);   // shadow of mode, readable in callbacks without stale closure

  // keep modeRef in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    loadTodaySessions().then(n => { setDaily(n); setLoaded(true); });
  }, []);

  // Stop bell on unmount (safety net)
  useEffect(() => () => bell.stop(), []);

  function triggerBell(msg) {
    bell.start();
    setBellActive(true);
    setAlertMsg(msg);
  }
  function dismissBell() {
    bell.stop();
    setBellActive(false);
    setAlertMsg("");
  }

  const totalDuration = MODES[mode].duration;
  const progress      = (totalDuration - timeLeft) / totalDuration;
  const color         = MODES[mode].color;

  // ── shared "session finished" logic ──────────────────────
  const finishSession = useCallback(() => {
    setRunning(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    startedAtRef.current = null;

    if (modeRef.current === "focus") {
      triggerBell("🎯 Focus session complete! Time for a break.");
      setSessions(s => s + 1);
      setDaily(d => {
        const next = d + 1;
        saveTodaySessions(next);
        return next;
      });
      setMode("short");
      setTimeLeft(MODES.short.duration);
    } else {
      triggerBell("☕ Break is over! Let's get back to work.");
      setMode("focus");
      setTimeLeft(MODES.focus.duration);
    }
  }, []);

  const switchMode = useCallback((m) => {
    setRunning(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    startedAtRef.current = null;
    setMode(m);
    setTimeLeft(MODES[m].duration);
  }, []);

  // ── main timer effect ─────────────────────────────────────
  useEffect(() => {
    if (running) {
      // Snapshot the start moment (only when freshly starting / resuming)
      if (startedAtRef.current === null) {
        startedAtRef.current     = Date.now();
        remainingAtStart.current = timeLeft;
      }

      intervalRef.current = setInterval(() => {
        const elapsed   = (Date.now() - startedAtRef.current) / 1000;
        const remaining = Math.max(remainingAtStart.current - elapsed, 0);

        if (remaining <= 0) {
          setTimeLeft(0);
          finishSession();
        } else {
          setTimeLeft(Math.ceil(remaining));
        }
      }, 500);   // poll every 500 ms – tight enough to never miss by a full second
    }

    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [running, finishSession]);

  // ── visibilitychange – recalculate immediately on tab return ─
  useEffect(() => {
    function onVisible() {
      if (!running || startedAtRef.current === null) return;
      const elapsed   = (Date.now() - startedAtRef.current) / 1000;
      const remaining = Math.max(remainingAtStart.current - elapsed, 0);
      if (remaining <= 0) {
        setTimeLeft(0);
        finishSession();
      } else {
        setTimeLeft(Math.ceil(remaining));
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [running, finishSession]);

  const minutes = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const seconds = String(timeLeft % 60).padStart(2, "0");

  const R             = 100;
  const circumference = 2 * Math.PI * R;
  const strokeOffset  = circumference * (1 - progress);

  const dailyGoal   = 8;
  const dailyPct    = Math.min(dailySessions / dailyGoal, 1);
  const totalFocMin = dailySessions * 25;

  return (
    <div style={styles.root}>
      <div style={styles.bgShine} />

      {/* Bell alert banner */}
      {bellActive && (
        <div style={styles.alertBanner}>
          <span style={styles.alertIcon}>🔔</span>
          <span style={styles.alertText}>{alertMsg}</span>
          <button onClick={dismissBell} style={styles.alertDismiss}>✕</button>
        </div>
      )}

      {/* Title */}
      <h1 style={styles.title}>Adishvar's Focus Sessions</h1>

      {/* Mode tabs */}
      <div style={styles.tabs}>
        {Object.entries(MODES).map(([key, m]) => (
          <button
            key={key}
            onClick={() => switchMode(key)}
            style={{
              ...styles.tab,
              color:        mode === key ? m.color : TEXT_LIGHT,
              borderBottom: mode === key ? `3px solid ${m.color}` : "3px solid transparent",
              background:   mode === key ? "rgba(255,255,255,0.18)" : "transparent",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Ring + time */}
      <div style={styles.clockWrap}>
        <svg width="250" height="250" style={styles.svg}>
          <defs>
            <linearGradient id="pGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stopColor={color} />
              <stop offset="100%" stopColor={color + "99"} />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <circle cx="125" cy="125" r={R} fill="none" stroke={BG_DEEP} strokeWidth="10" opacity="0.5"/>
          <circle
            cx="125" cy="125" r={R}
            fill="none"
            stroke="url(#pGrad)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            transform="rotate(-90 125 125)"
            filter="url(#glow)"
            style={{ transition: "stroke-dashoffset 0.95s linear, stroke 0.4s ease" }}
          />
        </svg>

        <div style={styles.timeDisplay}>
          <span style={{ ...styles.timeText, color }}>{minutes}</span>
          <span style={{ ...styles.colon,    color: running ? color : TEXT_LIGHT }}>:</span>
          <span style={{ ...styles.timeText, color }}>{seconds}</span>
        </div>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <button
          onClick={() => {
            if (running) {
              // pausing – clear the start snapshot so resume will re-snapshot
              startedAtRef.current = null;
            }
            setRunning(r => !r);
          }}
          style={{
            ...styles.startBtn,
            background: running ? TEXT_MID : color,
            boxShadow:  running ? "none"  : `0 6px 28px ${color}66`,
          }}
        >
          {running ? "PAUSE" : timeLeft === totalDuration ? "START" : "RESUME"}
        </button>
        <button
          onClick={() => {
            setRunning(false);
            clearInterval(intervalRef.current);
            intervalRef.current  = null;
            startedAtRef.current = null;
            setTimeLeft(MODES[mode].duration);
          }}
          style={styles.resetBtn}
        >
          ↺ &nbsp;RESET
        </button>
      </div>

      {/* Daily tracker card */}
      {loaded && (
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>TODAY'S PROGRESS</span>
            <span style={styles.cardPill}>{dailySessions} / {dailyGoal} sessions</span>
          </div>

          <div style={styles.barBg}>
            <div style={{
              ...styles.barFill,
              width:      `${dailyPct * 100}%`,
              background: dailyPct >= 1 ? SHORT_COLOR : FOCUS_COLOR,
            }}/>
          </div>

          <div style={styles.statsRow}>
            <div style={styles.stat}>
              <span style={styles.statNum}>{dailySessions}</span>
              <span style={styles.statLabel}>Sessions</span>
            </div>
            <div style={styles.statDivider}/>
            <div style={styles.stat}>
              <span style={styles.statNum}>{totalFocMin}</span>
              <span style={styles.statLabel}>Minutes</span>
            </div>
            <div style={styles.statDivider}/>
            <div style={styles.stat}>
              <span style={styles.statNum}>{dailySessions >= dailyGoal ? "🎉" : `${dailyGoal - dailySessions}`}</span>
              <span style={styles.statLabel}>{dailySessions >= dailyGoal ? "Goal hit!" : "Left"}</span>
            </div>
          </div>

          <div style={styles.dotsRow}>
            {Array.from({ length: dailyGoal }).map((_, i) => (
              <div key={i} style={{
                ...styles.dot,
                background: i < dailySessions ? FOCUS_COLOR : "rgba(255,255,255,0.28)",
                boxShadow:  i < dailySessions ? `0 0 7px ${FOCUS_COLOR}55` : "none",
              }}/>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh",
    background: `linear-gradient(165deg, ${BG} 0%, ${BG_DEEP} 100%)`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Georgia', serif",
    position: "relative",
    overflow: "hidden",
    color: TEXT_DARK,
    userSelect: "none",
    paddingBottom: "24px",
  },
  bgShine: {
    position: "fixed",
    top: "-30%", left: "-10%",
    width: "70%", height: "70%",
    background: "radial-gradient(ellipse, rgba(255,255,255,0.22) 0%, transparent 70%)",
    pointerEvents: "none",
  },

  title: {
    margin: "0 0 28px",
    fontSize: "26px",
    fontWeight: "bold",
    fontFamily: "'Georgia', serif",
    color: TEXT_DARK,
    letterSpacing: "1px",
    textAlign: "center",
    zIndex: 1,
    textShadow: "0 1px 3px rgba(255,255,255,0.4)",
  },

  tabs: {
    display: "flex",
    gap: "4px",
    marginBottom: "36px",
    zIndex: 1,
  },
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "3px solid transparent",
    padding: "10px 22px",
    fontSize: "15px",
    fontWeight: "bold",
    letterSpacing: "2px",
    cursor: "pointer",
    transition: "color 0.3s, border-color 0.3s, background 0.3s",
    fontFamily: "'Georgia', serif",
    borderRadius: "6px 6px 0 0",
  },

  clockWrap: {
    position: "relative",
    width: "250px",
    height: "250px",
    zIndex: 1,
  },
  svg: { position: "absolute", top: 0, left: 0 },
  timeDisplay: {
    position: "absolute", inset: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  timeText: {
    fontSize: "82px",
    fontWeight: "bold",
    letterSpacing: "-3px",
    lineHeight: 1,
    transition: "color 0.4s ease",
    fontFamily: "'Georgia', serif",
  },
  colon: {
    fontSize: "68px",
    fontWeight: "bold",
    marginBottom: "6px",
    animation: "blink 1s step-end infinite",
    transition: "color 0.4s ease",
    fontFamily: "'Georgia', serif",
  },

  controls: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "14px",
    marginTop: "38px",
    zIndex: 1,
  },
  startBtn: {
    border: "none",
    borderRadius: "8px",
    padding: "16px 58px",
    fontSize: "18px",
    letterSpacing: "3px",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "'Georgia', serif",
    fontWeight: "bold",
    transition: "background 0.3s, box-shadow 0.3s, transform 0.1s",
  },
  resetBtn: {
    background: "rgba(255,255,255,0.2)",
    border: "1px solid rgba(255,255,255,0.4)",
    borderRadius: "6px",
    padding: "9px 28px",
    fontSize: "14px",
    letterSpacing: "2px",
    color: TEXT_MID,
    cursor: "pointer",
    fontFamily: "'Georgia', serif",
    fontWeight: "bold",
    transition: "background 0.2s, color 0.2s",
  },

  card: {
    marginTop: "40px",
    width: "340px",
    background: CARD_BG,
    backdropFilter: "blur(8px)",
    border: `1px solid ${CARD_BORDER}`,
    borderRadius: "16px",
    padding: "24px 26px 20px",
    zIndex: 1,
    boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
  },
  cardTitle: {
    fontSize: "13px",
    fontWeight: "bold",
    letterSpacing: "2px",
    color: TEXT_MID,
  },
  cardPill: {
    fontSize: "13px",
    fontWeight: "bold",
    color: FOCUS_COLOR,
    background: "rgba(27,58,92,0.12)",
    padding: "4px 12px",
    borderRadius: "20px",
  },

  barBg: {
    width: "100%",
    height: "10px",
    background: "rgba(255,255,255,0.35)",
    borderRadius: "5px",
    overflow: "hidden",
    marginBottom: "20px",
  },
  barFill: {
    height: "100%",
    borderRadius: "5px",
    transition: "width 0.5s ease, background 0.4s",
  },

  statsRow: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: "18px",
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
    flex: 1,
  },
  statNum: {
    fontSize: "24px",
    fontWeight: "bold",
    color: TEXT_DARK,
    fontFamily: "'Georgia', serif",
  },
  statLabel: {
    fontSize: "11px",
    fontWeight: "bold",
    letterSpacing: "1.5px",
    color: TEXT_LIGHT,
    textTransform: "uppercase",
  },
  statDivider: {
    width: "1px",
    height: "32px",
    background: "rgba(255,255,255,0.4)",
    margin: "0 4px",
  },

  dotsRow: {
    display: "flex",
    justifyContent: "center",
    gap: "7px",
  },
  dot: {
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    transition: "background 0.35s, box-shadow 0.35s",
  },

  // bell alert banner
  alertBanner: {
    position: "fixed",
    top: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    gap: "12px",
    background: "rgba(15, 33, 55, 0.88)",
    backdropFilter: "blur(10px)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "14px",
    padding: "14px 20px 14px 18px",
    boxShadow: "0 6px 32px rgba(0,0,0,0.25)",
    animation: "slideDown 0.35s cubic-bezier(.34,1.56,.64,1) forwards",
    maxWidth: "90vw",
  },
  alertIcon: {
    fontSize: "22px",
    flexShrink: 0,
  },
  alertText: {
    fontSize: "15px",
    fontWeight: "bold",
    color: "#fff",
    fontFamily: "'Georgia', serif",
    letterSpacing: "0.3px",
    lineHeight: 1.3,
  },
  alertDismiss: {
    flexShrink: 0,
    marginLeft: "8px",
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: "6px",
    width: "28px",
    height: "28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(255,255,255,0.75)",
    fontSize: "14px",
    cursor: "pointer",
    transition: "background 0.2s, color 0.2s",
    fontFamily: "'Georgia', serif",
  },
};

const s = document.createElement("style");
s.textContent = `
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
  @keyframes slideDown {
    0%  { opacity:0; transform: translateX(-50%) translateY(-18px); }
    100%{ opacity:1; transform: translateX(-50%) translateY(0);     }
  }
  button:active { transform: scale(0.95) !important; }
`;
document.head.appendChild(s);
