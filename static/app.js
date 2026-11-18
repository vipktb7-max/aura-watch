// Watch room page. The server keeps the room's moment; only the host moves it; everyone follows.
// The host searches YouTube here, picks a video, and may choose what plays next; at the end of a video
// the server counts down 10 seconds and plays the chosen one (else the first of «التالي»).
(function () {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  const qs = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  if (tg) { tg.ready(); tg.expand(); }

  // «<room>_<tunnel>»: through the free Cloudflare tunnel the room server's address changes, so the room's
  // button carries it. Otherwise the room server is where this page is.
  const start = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "";
  const cut = start.indexOf("_");
  const roomId = (cut > 0 ? start.slice(0, cut) : start) || qs.get("room") || "";
  const tunnel = cut > 0 ? start.slice(cut + 1) : "";
  const server = qs.get("api") || (tunnel ? `${tunnel}.trycloudflare.com` : location.host);
  const init = (tg && tg.initData) || "";
  const guest = qs.get("guest") || "";                 // local testing in a plain browser (server in dev mode)

  let ws = null, state = null, got = 0, offset = 0, me = { id: 0, host: false };
  let player = null, ready = false, joined = false, retry = 800, applying = false, shownQuery = null;

  // ---------------------------------------------------------------- where the room is now
  function target() {
    if (!state) return 0;
    return state.pos + (state.playing ? (performance.now() - got) / 1000 : 0);
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function notice(text) { $("notice-text").textContent = text; $("notice").hidden = !text; }
  const hasVideo = () => !!(state && state.video && state.video.id);

  // ---------------------------------------------------------------- the connection
  function connect() {
    if (!roomId) return notice("افتح الغرفة من زر «افتح المشاهدة» في القروب");
    const proto = (tunnel || location.protocol === "https:") ? "wss" : "ws";
    let url = `${proto}://${server}/ws?room=${encodeURIComponent(roomId)}&init=${encodeURIComponent(init)}`;
    if (guest) url += `&guest=${encodeURIComponent(guest)}`;
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 800; };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "error") {
        ws.onclose = null;
        return notice(msg.why === "room" ? "هذي الغرفة انتهت او ما هي موجودة" : "افتح الغرفة من زر البوت في القروب");
      }
      if (msg.t === "state") onState(msg);
    };
    ws.onclose = () => {
      if (state && state.closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------------------------------------------------------------- the room changed
  function onState(s) {
    const old = state;
    state = s; got = performance.now(); me = s.you || me;
    offset = s.now - Date.now() / 1000;                // server clock vs this phone
    if (s.closed) {
      if (player && ready) player.pauseVideo();
      return notice("انتهت غرفة المشاهدة، شكراً لكم");
    }
    notice("");
    $("room-title").textContent = s.title || (s.video && s.video.title) || "غرفة مشاهدة";
    $("video-title").textContent = s.title && s.video ? (s.video.title || "") : (s.video && s.video.channel) || "";
    $("live").hidden = !s.playing;
    $("who").textContent = me.host ? "انت صاحب الغرفة، الكل يشوف معك" : `يتحكم بالغرفة ↤ ${s.host.name}`;
    $("search-box").hidden = !me.host;
    if (s.query !== shownQuery && document.activeElement !== $("search")) { $("search").value = s.query || ""; shownQuery = s.query; }
    $("controls").hidden = !me.host || !hasVideo();
    $("shield").hidden = me.host || !hasVideo();
    $("empty").hidden = hasVideo();
    $("empty-text").textContent = me.host ? "ابحث فوق واختار مقطع من النتايج" : "صاحب الغرفة يختار مقطع";
    $("skip").disabled = !(s.next && s.next.length);
    $("tap-back").hidden = $("tap-fwd").hidden = !me.host || !hasVideo();
    renderVideos("results", s.results || [], { pick: true });
    $("results-box").hidden = !(s.results && s.results.length);
    $("results-q").textContent = s.query || "";
    renderVideos("next-list", s.next || [], { choose: true, chosen: s.chosen });
    $("next-box").hidden = !hasVideo();
    $("next-hint").textContent = me.host ? "اضغط على اللي تبيه بعده" : "";
    renderEpisodes(s);
    renderViewers(s);
    countdown();
    if (!hasVideo()) { if (player && ready) player.stopVideo(); return; }
    if (!player) return makePlayer(s.video.id);
    if (!ready) return;
    if (!old || !old.video || old.video.id !== s.video.id) {
      applying = true;
      if (s.playing && joined) player.loadVideoById({ videoId: s.video.id, startSeconds: target() });
      else player.cueVideoById({ videoId: s.video.id, startSeconds: target() });
      return;
    }
    follow();
  }

  // viewers (and the host's other tabs) follow the room
  function follow() {
    if (!player || !ready || !state || state.closed || !hasVideo()) return;
    const want = target();
    const st = player.getPlayerState();
    if (Math.abs((player.getCurrentTime() || 0) - want) > 1.5) { applying = true; player.seekTo(want, true); }
    if (state.playing && joined && st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) { applying = true; player.playVideo(); }
    if (!state.playing && st === YT.PlayerState.PLAYING) { applying = true; player.pauseVideo(); }
    $("join").hidden = joined || !state.playing;
  }
  setInterval(follow, 2000);

  // the 10 seconds before the next video (the server plays it; this only shows it)
  function countdown() {
    const s = state;
    const on = !!(s && s.advance_at && s.ended && !s.closed);
    $("countdown").hidden = !on;
    if (!on) return;
    const left = Math.max(0, Math.ceil(s.advance_at - (Date.now() / 1000 + offset)));
    const nxt = s.next[(s.chosen !== null && s.chosen < s.next.length) ? s.chosen : 0] || {};
    $("countdown-n").textContent = left;
    $("countdown-title").textContent = nxt.title || "";
  }

  // ---------------------------------------------------------------- YouTube player
  window.onYouTubeIframeAPIReady = function () { if (hasVideo() && !player) makePlayer(state.video.id); };
  function makePlayer(videoId) {
    if (!window.YT || !YT.Player) return;
    player = new YT.Player("player", {
      host: "https://www.youtube-nocookie.com",          // YouTube's privacy player: no tracking, fewer ads
      videoId,
      playerVars: { controls: me.host ? 1 : 0, disablekb: me.host ? 0 : 1, rel: 0, playsinline: 1, iv_load_policy: 3,
                    modestbranding: 1, fs: 0, start: Math.floor(target()) },
      events: {
        onReady: () => { ready = true; joined = joined || !state.playing; follow(); },
        onStateChange: onPlayer,
        onError: () => notice("هذا الفيديو صاحبه مانع عرضه برا يوتيوب" + (me.host ? "، اختار غيره" : ""))
      }
    });
  }
  function onPlayer(e) {
    if (applying) { if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.CUED) applying = false; return; }
    if (!me.host || !state) return;
    const pos = player.getCurrentTime() || 0;
    if (e.data === YT.PlayerState.PLAYING && (!state.playing || Math.abs(pos - target()) > 1.5)) send({ t: "play", pos });
    else if (e.data === YT.PlayerState.PAUSED && state.playing) send({ t: "pause", pos });
    else if (e.data === YT.PlayerState.ENDED && !state.ended) send({ t: "ended" });
  }
  const api = document.createElement("script");
  api.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(api);

  // ---------------------------------------------------------------- lists
  function row(v, i, opts) {
    const li = document.createElement("li");
    const th = document.createElement("div"); th.className = "thumb";
    th.style.backgroundImage = `url("https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg")`;
    if (v.duration) { const d = document.createElement("span"); d.className = "dur"; d.textContent = fmt(v.duration); th.appendChild(d); }
    const meta = document.createElement("div"); meta.className = "meta";
    const t = document.createElement("p"); t.className = "vt"; t.textContent = v.title || "";
    const c = document.createElement("p"); c.className = "vc"; c.textContent = v.channel || "";
    meta.append(t, c);
    const none = opts.chosen === null || opts.chosen === undefined;
    if (opts.choose && (none ? i === 0 : i === opts.chosen)) {
      li.className = "picked";
      const b = document.createElement("span"); b.className = "badge";
      b.textContent = none ? "يشتغل بعده" : "اخترته بعده";
      meta.appendChild(b);
    }
    if (opts.pick && state.video && v.id === state.video.id) li.className = "picked";
    li.append(th, meta);
    if (me.host) {
      if (opts.pick) li.onclick = () => { joined = true; send({ t: "pick", i }); window.scrollTo({ top: 0, behavior: "smooth" }); };
      if (opts.choose) li.onclick = () => send({ t: "choose", i });
    }
    return li;
  }
  function renderVideos(id, list, opts) {
    const ul = $(id);
    ul.className = "videos" + (me.host ? " host" : "");
    if (!list.length && opts.choose) {
      const p = document.createElement("li"); p.className = "muted"; p.textContent = "يجهز…";
      return ul.replaceChildren(p);
    }
    ul.replaceChildren(...list.map((v, i) => row(v, i, opts)));
  }
  function renderEpisodes(s) {
    $("episodes-box").hidden = s.items.length < 2;
    const ol = $("episodes");
    ol.className = "episodes" + (me.host ? " host" : "");
    ol.replaceChildren(...s.items.map((it, i) => {
      const li = document.createElement("li");
      li.textContent = it.title || `الحلقة ${i + 1}`;
      if (i === s.index) li.className = "now";
      if (me.host && i !== s.index) li.onclick = () => send({ t: "video", index: i });
      return li;
    }));
  }
  function renderViewers(s) {
    $("count").textContent = s.viewers.length;
    $("viewers").replaceChildren(...s.viewers.map((v) => {
      const li = document.createElement("li");
      const av = document.createElement("span"); av.className = "avatar"; av.textContent = (v.name || "?").trim().charAt(0);
      const nm = document.createElement("span"); nm.className = "name"; nm.textContent = v.name;
      if (v.id === s.host.id) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "صاحب الغرفة"; nm.appendChild(t); }
      const tm = document.createElement("span"); tm.className = "time"; tm.dataset.since = v.since;
      li.append(av, nm, tm);
      return li;
    }));
    tick();
  }
  function tick() {
    document.querySelectorAll(".time").forEach((el) => {
      el.textContent = fmt(Date.now() / 1000 + offset - Number(el.dataset.since));
    });
    countdown();
  }
  setInterval(tick, 1000);

  // ---------------------------------------------------------------- buttons
  $("search-box").onsubmit = (e) => {
    e.preventDefault();
    const q = $("search").value.trim();
    if (!q) return;
    $("search").blur();
    send({ t: "search", q });
  };
  $("join").onclick = () => { joined = true; $("join").hidden = true; follow(); if (ready && state.playing) player.playVideo(); };
  // YouTube's double tap: two quick taps on the right go 10 s forward, each tap after that 10 s more (the left
  // side goes back). The room moves once, when the taps stop.
  const dbl = { side: "", last: 0, total: 0, base: 0, timer: 0, hide: 0 };
  function dblTap(side) {
    if (!player || !ready) return;
    const now = performance.now();
    const going = dbl.total && dbl.side === side && now - dbl.last < 800;
    const second = !dbl.total && dbl.side === side && now - dbl.last < 350;
    dbl.side = side; dbl.last = now;
    if (!going && !second) { dbl.total = 0; return; }
    if (second) dbl.base = player.getCurrentTime() || 0;
    dbl.total += 10;
    const dir = side === "fwd" ? 1 : -1;
    const pos = Math.max(0, dbl.base + dir * dbl.total);
    applying = true; player.seekTo(pos, true);
    const b = $("seek-bubble");
    b.className = "bubble " + (side === "fwd" ? "right" : "left");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 24 24");
    arrow.innerHTML = side === "fwd" ? '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>' : '<path d="M19 6l-6 6 6 6M12 6l-6 6 6 6"/>';
    const words = document.createElement("span"); words.textContent = `${dbl.total} ثانية`;
    if (side === "fwd") b.replaceChildren(words, arrow); else b.replaceChildren(arrow, words);
    b.hidden = false;
    clearTimeout(dbl.timer); clearTimeout(dbl.hide);
    dbl.timer = setTimeout(() => { joined = true; send({ t: "seek", pos }); dbl.total = 0; dbl.side = ""; }, 800);
    dbl.hide = setTimeout(() => { b.hidden = true; }, 900);
  }
  $("tap-fwd").addEventListener("pointerdown", (e) => { e.preventDefault(); dblTap("fwd"); });
  $("tap-back").addEventListener("pointerdown", (e) => { e.preventDefault(); dblTap("back"); });
  $("skip").onclick = () => { joined = true; send({ t: "skip" }); };
  $("end").onclick = () => {
    const go = () => send({ t: "close" });
    if (tg && tg.showConfirm) tg.showConfirm("تنهي غرفة المشاهدة للكل؟", (ok) => ok && go()); else if (confirm("تنهي غرفة المشاهدة للكل؟")) go();
  };
  $("fullscreen").onclick = () => {
    const el = $("stage");
    if (document.fullscreenElement) return document.exitFullscreen();
    if (el.requestFullscreen) el.requestFullscreen().catch(() => tg && tg.requestFullscreen && tg.requestFullscreen());
    else if (tg && tg.requestFullscreen) tg.requestFullscreen();
  };

  connect();
})();
