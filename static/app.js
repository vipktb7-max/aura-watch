// Watch room page. The server keeps the room's moment; only the host moves it; everyone follows.
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

  let ws = null, state = null, got = 0, me = { id: 0, host: false };
  let player = null, ready = false, joined = false, retry = 800, applying = false;

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
    if (s.closed) {
      if (player && ready) player.pauseVideo();
      return notice("انتهت غرفة المشاهدة، شكراً لكم");
    }
    notice("");
    $("room-title").textContent = s.title || "غرفة مشاهدة";
    $("video-title").textContent = s.items.length > 1 ? (s.video.title || "") : "";
    $("live").hidden = !s.playing;
    $("who").textContent = me.host ? "انت صاحب الغرفة، الكل يشوف معك" : `يتحكم بالغرفة ↤ ${s.host.name}`;
    $("controls").hidden = !me.host;
    $("shield").hidden = me.host;
    $("next").disabled = s.index >= s.items.length - 1;
    $("toggle").textContent = s.playing ? "ايقاف" : "تشغيل";
    renderEpisodes(s);
    renderViewers(s);
    if (!player) return makePlayer(s.video.id);
    if (!ready) return;
    if (!old || old.video.id !== s.video.id) {
      applying = true;
      if (s.playing && joined) player.loadVideoById({ videoId: s.video.id, startSeconds: target() });
      else player.cueVideoById({ videoId: s.video.id, startSeconds: target() });
      return;
    }
    follow();
  }

  // viewers (and the host's other tabs) follow the room
  function follow() {
    if (!player || !ready || !state || state.closed) return;
    const want = target();
    const st = player.getPlayerState();
    if (Math.abs((player.getCurrentTime() || 0) - want) > 1.5) { applying = true; player.seekTo(want, true); }
    if (state.playing && joined && st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) { applying = true; player.playVideo(); }
    if (!state.playing && st === YT.PlayerState.PLAYING) { applying = true; player.pauseVideo(); }
    $("join").hidden = joined || !state.playing;
  }
  setInterval(follow, 2000);

  // ---------------------------------------------------------------- YouTube player
  window.onYouTubeIframeAPIReady = function () { if (state && !player) makePlayer(state.video.id); };
  function makePlayer(videoId) {
    if (!window.YT || !YT.Player) return;
    player = new YT.Player("player", {
      videoId,
      playerVars: { controls: me.host ? 1 : 0, disablekb: me.host ? 0 : 1, rel: 0, playsinline: 1,
                    modestbranding: 1, fs: 0, start: Math.floor(target()) },
      events: {
        onReady: () => { ready = true; joined = !state.playing; follow(); },
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
    else if (e.data === YT.PlayerState.ENDED && state.index < state.items.length - 1) send({ t: "video", index: state.index + 1 });
  }
  const api = document.createElement("script");
  api.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(api);

  // ---------------------------------------------------------------- lists
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
    const offset = s.now - Date.now() / 1000;          // server clock vs this phone
    $("viewers").replaceChildren(...s.viewers.map((v) => {
      const li = document.createElement("li");
      const av = document.createElement("span"); av.className = "avatar"; av.textContent = (v.name || "?").trim().charAt(0);
      const nm = document.createElement("span"); nm.className = "name"; nm.textContent = v.name;
      if (v.id === s.host.id) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "صاحب الغرفة"; nm.appendChild(t); }
      const tm = document.createElement("span"); tm.className = "time"; tm.dataset.since = v.since; tm.dataset.offset = offset;
      li.append(av, nm, tm);
      return li;
    }));
    tick();
  }
  function tick() {
    document.querySelectorAll(".time").forEach((el) => {
      el.textContent = fmt(Date.now() / 1000 + Number(el.dataset.offset) - Number(el.dataset.since));
    });
  }
  setInterval(tick, 1000);

  // ---------------------------------------------------------------- buttons
  $("join").onclick = () => { joined = true; $("join").hidden = true; follow(); if (ready && state.playing) player.playVideo(); };
  $("toggle").onclick = () => { if (!player || !ready) return; joined = true;
    const pos = player.getCurrentTime() || 0; send({ t: state.playing ? "pause" : "play", pos }); };
  $("back10").onclick = () => ready && send({ t: "seek", pos: Math.max(0, (player.getCurrentTime() || 0) - 10) });
  $("fwd10").onclick = () => ready && send({ t: "seek", pos: (player.getCurrentTime() || 0) + 10 });
  $("next").onclick = () => state && send({ t: "video", index: state.index + 1 });
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
