(() => {
  "use strict";

  // Local-only prototype. No network calls, remote API, or real multiplayer.
  const SAVE_KEY = "nana-bread-battle-v7";
  const SIZE = 27;
  const REGION_SIZE = 9;
  const REGION_COUNT = 3;
  const TILE_COUNT = SIZE * SIZE;
  const HOME = 13 * SIZE + 13;
  const STEP_MS = 2200;
  const UNIT_SECONDS = 8;
  const MAX_LEVEL = 10;
  const STARTING_TYPES = new Map([[HOME, "home"]]);
  const AI_STARTS = [
    { id: "ai-crust", name: "The Crust Coalition", x: 4, y: 4 },
    { id: "ai-sourdough", name: "Sourdough Syndicate", x: 22, y: 4 },
    { id: "ai-brioche", name: "Brioche Brigade", x: 4, y: 22 },
    { id: "ai-rye", name: "The Rye Republic", x: 22, y: 22 }
  ];

  const el = id => document.getElementById(id);
  const idx = (x, y) => y * SIZE + x;
  const xy = i => ({ x: i % SIZE, y: Math.floor(i / SIZE) });
  const regionOf = i => ({ x: Math.floor(xy(i).x / REGION_SIZE), y: Math.floor(xy(i).y / REGION_SIZE) });
  const visibleIndices = () => {
    const out = [];
    const startX = state.regionX * REGION_SIZE, startY = state.regionY * REGION_SIZE;
    for (let y = startY; y < startY + REGION_SIZE; y++) for (let x = startX; x < startX + REGION_SIZE; x++) out.push(idx(x, y));
    return out;
  };
  const visibleIndex = i => {
    const { x, y } = xy(i);
    const localX = x - state.regionX * REGION_SIZE, localY = y - state.regionY * REGION_SIZE;
    return localX >= 0 && localX < REGION_SIZE && localY >= 0 && localY < REGION_SIZE ? localY * REGION_SIZE + localX : -1;
  };
  const manhattan = (a, b) => Math.abs(xy(a).x - xy(b).x) + Math.abs(xy(a).y - xy(b).y);
  const neighbours = i => {
    const { x, y } = xy(i);
    return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
      .filter(([x2, y2]) => x2 >= 0 && x2 < SIZE && y2 >= 0 && y2 < SIZE)
      .map(([x2, y2]) => idx(x2, y2));
  };

  const META = {
    home:   { icon: "🏡", name: "Nana's Homestead", desc: "Your headquarters. Upgrade your brigade, each resource's carrying capacity, and your bread treasury here." },
    empty:  { icon: "🌿", name: "Open Meadow", desc: "Unclaimed land. March your brigade onto it to claim it without paying bread." },
    field:  { icon: "🌾", name: "Wheat Field", desc: "Wheat grows here. Soldiers must harvest it and carry it to a mill." },
    mill:   { icon: "⚙️", name: "Flour Mill", desc: "Unload wheat, then assign your soldiers to mill it into flour. Leaving pauses the work." },
    bakery: { icon: "🥖", name: "Bakery", desc: "Deliver flour, then assign your soldiers to bake bread. Output stops at the bakery's bread capacity." },
    fog:    { icon: "❔", name: "Uncharted Plot", desc: "Unknown countryside. March through it to discover its terrain and any defenders." }
  };

  function fieldCap(tile) { return 10 * tile.level; }
  function millInputCap(tile) { return 10 * tile.level; }
  function millFlourCap(tile) { return 10 * tile.level; }
  function bakeryFlourCap(tile) { return 10 * tile.level; }
  function bakeryBreadCap(tile) { return 10 * tile.level; }
  function stageSeconds(tile) { return Math.max(3, UNIT_SECONDS / tile.level); }
  function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }
  function treasuryCapacityFor(level) { return 30 + (Math.max(1, level) - 1) * 20; }
  function carryCapacityFor(level) { return 6 + (Math.max(1, level) - 1) * 4; }

  function randomPlotType() {
    const roll = Math.random();
    if (roll < 9 / 12) return "empty";
    if (roll < 10 / 12) return "field";
    if (roll < 11 / 12) return "mill";
    return "bakery";
  }

  function makeTile(i) {
    const isHome = STARTING_TYPES.has(i);
    const type = isHome ? "home" : "fog";
    const hiddenType = isHome ? null : randomPlotType();
    const hiddenOwner = !isHome && Math.random() < 0.09 ? "npc" : null;
    const hiddenGuard = hiddenOwner ? 3 + Math.floor(Math.random() * 5) : 0;
    return {
      type, hiddenType,
      hiddenOwner: isHome ? null : hiddenOwner,
      hiddenGuard: isHome ? 0 : hiddenGuard,
      owner: isHome ? "you" : null,
      guard: 0, level: 1, wheat: 0, wheatProgress: 0,
      grain: 0, flour: 0, processProgress: 0, bread: 0, bakeProgress: 0, workActive: false
    };
  }

  function newGame() {
    const now = Date.now();
    const tiles = Array.from({ length: TILE_COUNT }, (_, i) => makeTile(i));
    const aiPlayers = AI_STARTS.map((definition, index) => {
      const home = idx(definition.x, definition.y);
      const tile = tiles[home];
      tile.type = "fog";
      tile.hiddenType = "home";
      tile.hiddenOwner = definition.id;
      tile.hiddenGuard = 8;
      tile.owner = null;
      tile.guard = 0;
      return {
        id: definition.id, name: definition.name, home, at: home,
        troops: 8, level: 1, carryLevel: 1,
        inventory: { bread: 0, wheat: 0, flour: 0 },
        treasury: { stored: 12, level: 1 }, moving: null, activity: null,
        nextDecisionAt: now + 8000 + index * 2500,
        nextRaidAt: now + 115000 + index * 20000,
        knownTiles: [home], alive: true, objective: "build supply chain", lastTarget: null
      };
    });
    return {
      version: 7, regionX: 1, regionY: 1, tiles, aiPlayers,
      treasury: { stored: 12, level: 1 },
      army: { at: HOME, troops: 10, level: 1, carryLevel: 1,
        inventory: { bread: 0, wheat: 0, flour: 0 }, moving: null, activity: null },
      selected: HOME, lastTick: now,
      events: ["The Flourlands await their baker-general. Only the homestead is visible; rival bakeries are at work beyond the fog."]
    };
  }

  function validateSave(s) {
    if (!s || s.version !== 7 || !Array.isArray(s.tiles) || s.tiles.length !== TILE_COUNT || !s.army || !s.treasury || !Array.isArray(s.aiPlayers)) return null;
    s.treasury.level = clampInt(s.treasury.level, 1, MAX_LEVEL, 1);
    s.treasury.stored = Math.max(0, Math.min(treasuryCapacityFor(s.treasury.level), Number(s.treasury.stored) || 0));
    s.regionX = clampInt(s.regionX, 0, REGION_COUNT - 1, 1);
    s.regionY = clampInt(s.regionY, 0, REGION_COUNT - 1, 1);
    s.selected = clampInt(s.selected, 0, TILE_COUNT - 1, HOME);
    s.army.at = clampInt(s.army.at, 0, TILE_COUNT - 1, HOME);
    s.army.troops = Math.max(1, Math.floor(Number(s.army.troops) || 10));
    s.army.level = clampInt(s.army.level, 1, MAX_LEVEL, 1);
    s.army.carryLevel = clampInt(s.army.carryLevel, 1, MAX_LEVEL, 1);
    if (!s.army.inventory || typeof s.army.inventory !== "object") s.army.inventory = { bread: 0, wheat: 0, flour: 0 };
    const cap = carryCapacityFor(s.army.carryLevel);
    for (const kind of ["bread", "wheat", "flour"]) {
      s.army.inventory[kind] = Math.max(0, Math.min(cap, Number(s.army.inventory[kind]) || 0));
    }
    if (!s.army.moving || !Array.isArray(s.army.moving.path) || !Number.isFinite(s.army.moving.arriveAt) || !Number.isFinite(s.army.moving.startedAt)) {
      s.army.moving = null;
    } else {
      s.army.moving.path = s.army.moving.path.map(n => clampInt(n, 0, TILE_COUNT - 1, HOME));
      if (s.army.moving.path.length < 2) s.army.moving = null;
      else s.army.moving.revealedSteps = clampInt(s.army.moving.revealedSteps, 0, s.army.moving.path.length - 1, 0);
    }
    if (!s.army.activity || !Number.isFinite(s.army.activity.finishAt) || !Number.isFinite(s.army.activity.startedAt)) s.army.activity = null;
    else if (!["collect-wheat", "collect-flour", "load-bread"].includes(s.army.activity.type)) s.army.activity = null;
    if (!Array.isArray(s.events)) s.events = [];
    const validOwners = new Set(["you", "npc", null, ...s.aiPlayers.map(a => a && a.id).filter(Boolean)]);
    for (const t of s.tiles) {
      if (!META[t.type]) t.type = "fog";
      if (t.type !== "fog") { t.hiddenType = null; t.hiddenOwner = null; t.hiddenGuard = 0; }
      if (t.type === "fog" && !META[t.hiddenType]) t.hiddenType = "empty";
      t.owner = validOwners.has(t.owner) ? t.owner : null;
      if (!validOwners.has(t.hiddenOwner)) t.hiddenOwner = null;
      t.hiddenGuard = Math.max(0, Math.floor(Number(t.hiddenGuard) || 0));
      t.level = clampInt(t.level, 1, MAX_LEVEL, 1);
      t.guard = Math.max(0, Math.floor(Number(t.guard) || 0));
      for (const key of ["wheat", "wheatProgress", "grain", "flour", "processProgress", "bread", "bakeProgress"]) {
        t[key] = Math.max(0, Number(t[key]) || 0);
      }
      t.workActive = Boolean(t.workActive);
    }
    s.aiPlayers = s.aiPlayers.filter(a => a && typeof a.id === "string" && typeof a.name === "string");
    for (const a of s.aiPlayers) {
      a.home = clampInt(a.home, 0, TILE_COUNT - 1, HOME);
      a.at = clampInt(a.at, 0, TILE_COUNT - 1, a.home);
      a.troops = clampInt(a.troops, 1, 200, 8);
      a.level = clampInt(a.level, 1, MAX_LEVEL, 1);
      a.carryLevel = clampInt(a.carryLevel, 1, MAX_LEVEL, 1);
      if (!a.inventory || typeof a.inventory !== "object") a.inventory = { bread: 0, wheat: 0, flour: 0 };
      const aiCap = carryCapacityFor(a.carryLevel);
      for (const kind of ["bread", "wheat", "flour"]) a.inventory[kind] = Math.max(0, Math.min(aiCap, Number(a.inventory[kind]) || 0));
      if (!a.treasury || typeof a.treasury !== "object") a.treasury = { stored: 12, level: 1 };
      a.treasury.level = clampInt(a.treasury.level, 1, MAX_LEVEL, 1);
      a.treasury.stored = Math.max(0, Math.min(treasuryCapacityFor(a.treasury.level), Number(a.treasury.stored) || 0));
      if (!a.moving || !Array.isArray(a.moving.path) || !Number.isFinite(a.moving.arriveAt) || !Number.isFinite(a.moving.startedAt)) a.moving = null;
      if (!a.activity || !Number.isFinite(a.activity.finishAt) || !Number.isFinite(a.activity.startedAt)) a.activity = null;
      a.alive = a.alive !== false;
      if (!Array.isArray(a.knownTiles)) a.knownTiles = [a.home];
      a.knownTiles = [...new Set(a.knownTiles.map(n => clampInt(n, 0, TILE_COUNT - 1, a.home)))];
      if (!a.knownTiles.includes(a.home)) a.knownTiles.push(a.home);
      a.nextDecisionAt = Number(a.nextDecisionAt) || Date.now() + 3000;
      a.nextRaidAt = Number(a.nextRaidAt) || Date.now() + 120000;
    }
    // If a saved march was interrupted before its next animation frame, reveal all passed plots.
    if (s.outcome !== "lost") delete s.outcome;
    s.lastTick = Number(s.lastTick) || Date.now();
    return s;
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const valid = validateSave(JSON.parse(raw));
        if (valid) return valid;
      }
    } catch { /* Invalid or unavailable local saves begin a fresh local prototype. */ }
    return newGame();
  }

  let state = loadGame();
  let message = "Your brigade is ready. Marching will reveal every plot it passes through.";
  let mapBuilt = false;
  let lastDraw = 0;
  let lastStored = 0;
  let dropEnabled = false;
  let lastActionSignature = "";

  const army = () => state.army;
  const ownedTiles = () => state.tiles.filter(t => t.owner === "you");
  const countOwned = type => ownedTiles().filter(t => t.type === type).length;
  const carryCapacity = () => carryCapacityFor(state.army.carryLevel);
  const remainingCarry = kind => Math.max(0, carryCapacity() - Math.floor(state.army.inventory[kind] || 0));
  const inventory = kind => Math.floor(state.army.inventory[kind] || 0);
  const hasInventory = kind => inventory(kind) > 0;
  const hasAnyInventory = () => ["bread", "wheat", "flour"].some(hasInventory);
  const treasuryCapacity = () => treasuryCapacityFor(state.treasury.level);
  const safeTreasuryBread = () => Math.floor(state.treasury.stored * 2 / 3);
  const exposedTreasuryBread = () => state.treasury.stored - safeTreasuryBread();
  const safeCarriedBread = () => Math.floor(inventory("bread") / 4);
  const exposedCarriedBread = () => inventory("bread") - safeCarriedBread();
  const totalBread = () => state.treasury.stored + inventory("bread") + ownedTiles().filter(t => t.type === "bakery").reduce((n, t) => n + t.bread, 0);
  const troopStrength = () => state.army.troops + (state.army.level - 1) * 3;
  const aiById = id => state.aiPlayers?.find(a => a.id === id) || null;
  const isAIId = id => typeof id === "string" && id.startsWith("ai-");
  const realType = tile => tile.type === "fog" ? (META[tile.hiddenType] ? tile.hiddenType : "empty") : tile.type;
  const realOwner = tile => tile.type === "fog" ? (tile.hiddenOwner || null) : (tile.owner || null);
  const ownerAt = i => realOwner(state.tiles[i]);
  const typeAt = i => realType(state.tiles[i]);
  function setTileOwner(i, owner, guard = 0) {
    const tile = state.tiles[i];
    if (tile.type === "fog") { tile.hiddenOwner = owner || null; tile.hiddenGuard = Math.max(0, guard); }
    else { tile.owner = owner || null; tile.guard = Math.max(0, guard); }
  }
  function ownerName(owner) {
    if (owner === "you") return "You";
    if (owner === "npc") return "Frontier guards";
    const ai = aiById(owner);
    return ai ? ai.name : "Unclaimed";
  }

  function note(text) {
    message = text;
    state.events.unshift(text);
    state.events = state.events.slice(0, 6);
  }
  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); }
    catch { message = "Warning: this browser could not save progress. Check local storage settings."; }
  }

  function reveal(i) {
    const tile = state.tiles[i];
    if (!tile || tile.type !== "fog") return false;
    tile.type = META[tile.hiddenType] ? tile.hiddenType : "empty";
    tile.owner = tile.hiddenOwner || null;
    tile.guard = tile.owner ? Math.max(0, Number(tile.hiddenGuard) || 0) : 0;
    tile.hiddenType = null;
    tile.hiddenOwner = null;
    tile.hiddenGuard = 0;
    return true;
  }

  function routeBetween(from, to) {
    const a = xy(from), b = xy(to), path = [from];
    let x = a.x, y = a.y;
    while (x !== b.x) { x += x < b.x ? 1 : -1; path.push(idx(x, y)); }
    while (y !== b.y) { y += y < b.y ? 1 : -1; path.push(idx(x, y)); }
    return path;
  }
  function marchMs(from, to) { return Math.max(700, manhattan(from, to) * STEP_MS); }
  function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    return safe >= 60 ? `${Math.floor(safe / 60)}m ${Math.ceil(safe % 60)}s` : `${safe.toFixed(1)}s`;
  }

  function pauseCurrentWorkForMarch() {
    const from = state.army.at;
    let didPause = false;
    if (state.army.activity) {
      state.army.activity = null;
      didPause = true;
    }
    const tile = state.tiles[from];
    if (tile && tile.workActive) {
      tile.workActive = false;
      didPause = true;
    }
    if (didPause) note("Work stopped because the brigade left this plot. Uncollected goods stay put and paused milling/baking can be resumed when you return.");
  }

  function startMarch(to) {
    if (state.outcome === "lost" || state.army.moving) return;
    if (to === state.army.at) {
      state.selected = to;
      message = "Your brigade is already at this plot.";
      renderAll();
      return;
    }
    pauseCurrentWorkForMarch();
    const from = state.army.at;
    const path = routeBetween(from, to);
    const duration = marchMs(from, to);
    const startedAt = Date.now();
    state.selected = to;
    state.army.moving = { from, to, path, startedAt, arriveAt: startedAt + duration, duration, revealedSteps: 0 };
    note(`Brigade marching ${manhattan(from, to)} grid step(s). Every unknown plot crossed will be revealed along the way.`);
    save();
    renderAll();
  }

  function revealMovementProgress() {
    const movement = state.army.moving;
    if (!movement) return;
    const steps = movement.path.length - 1;
    if (steps <= 0) return;
    const ratio = Math.max(0, Math.min(1, (Date.now() - movement.startedAt) / Math.max(1, movement.duration)));
    const passed = Math.min(steps, Math.floor(ratio * steps + 0.00001));
    let changed = false;
    while (movement.revealedSteps < passed) {
      movement.revealedSteps++;
      const step = movement.path[movement.revealedSteps];
      changed = reveal(step) || changed;
      const region = regionOf(step);
      if (region.x !== state.regionX || region.y !== state.regionY) {
        state.regionX = region.x; state.regionY = region.y;
        mapBuilt = false;
      }
    }
    if (changed) save();
  }

  function finishMarch() {
    const movement = state.army.moving;
    if (!movement) return;
    for (const plot of movement.path.slice(1)) reveal(plot);
    const from = movement.from;
    const to = movement.to;
    state.army.moving = null;
    state.army.at = to;
    const target = state.tiles[to];

    const defenderOwner = target.owner;
    if (defenderOwner && defenderOwner !== "you") {
      const defendingAI = aiById(defenderOwner);
      const aiIsPresent = defendingAI && defendingAI.alive && defendingAI.at === to && !defendingAI.moving;
      const defense = Math.max(1, aiIsPresent ? troopStrengthForAI(defendingAI) : (target.guard || 0));
      const strength = troopStrength();
      if (strength >= defense + 2) {
        const losses = Math.min(Math.max(0, state.army.troops - 1), Math.max(1, Math.ceil(defense * 0.25)));
        state.army.troops -= losses;
        if (defendingAI) {
          if (typeAt(to) === "home") eliminateAI(defendingAI, false);
          else if (aiIsPresent) {
            defendingAI.troops = Math.max(1, defendingAI.troops - Math.max(1, Math.ceil(strength * 0.25)));
            defendingAI.at = defendingAI.home;
            defendingAI.moving = null;
            defendingAI.activity = null;
          }
        }
        setTileOwner(to, "you", 0);
        target.workActive = false;
        note(`Victory! You captured ${META[target.type].name.toLowerCase()} from ${ownerName(defenderOwner)}. Your brigade lost ${losses} guard(s).`);
      } else {
        const losses = Math.min(Math.max(0, state.army.troops - 1), Math.max(1, Math.ceil(state.army.troops * 0.35)));
        state.army.troops -= losses;
        state.army.at = from;
        note(`The defenders of ${ownerName(defenderOwner)} held. You lost ${losses} guard(s) and retreated.`);
      }
    } else if (!defenderOwner) {
      setTileOwner(to, "you", 0);
      note(target.type === "empty" ? "Plot claimed! Moving onto unclaimed land claims it without a bread payment." : `You secured the ${META[target.type].name.toLowerCase()} and claimed its land.`);
    } else {
      note(`Your brigade arrived at ${META[target.type].name.toLowerCase()}.`);
    }

    state.selected = state.army.at;
    save();
    renderAll();
  }

  function startActivity(type, amount) {
    if (state.outcome === "lost" || state.army.activity || state.army.moving || amount <= 0) return;
    const now = Date.now();
    const duration = 900 + Math.max(1, amount) * 650;
    state.army.activity = { type, tileIndex: state.army.at, amount, startedAt: now, finishAt: now + duration };
    const messages = {
      "collect-wheat": `Soldiers are harvesting up to ${amount} wheat. Leaving the plot cancels this work.`,
      "collect-flour": `Soldiers are loading up to ${amount} flour. Leaving the plot cancels this work.`,
      "load-bread": `Soldiers are loading up to ${amount} bread. Leaving the plot cancels this work.`
    };
    note(messages[type] || "Soldiers are working.");
    save(); renderAll();
  }

  function finishActivity() {
    const job = state.army.activity;
    if (!job) return;
    // A movement order cancels the job, so no cargo can be collected away from its source.
    if (state.army.moving || state.army.at !== job.tileIndex) {
      state.army.activity = null;
      save();
      return;
    }
    const tile = state.tiles[job.tileIndex];
    const amount = Math.max(0, Math.floor(job.amount));
    state.army.activity = null;
    if (job.type === "collect-wheat") {
      const collected = Math.min(amount, Math.floor(tile.wheat), remainingCarry("wheat"));
      if (collected > 0) {
        tile.wheat -= collected;
        state.army.inventory.wheat += collected;
        note(`Harvest complete: ${collected} wheat loaded. Carry it to a mill.`);
      } else note("No wheat could be collected. Wait for the field to grow or free wheat capacity.");
    } else if (job.type === "collect-flour") {
      const collected = Math.min(amount, Math.floor(tile.flour), remainingCarry("flour"));
      if (collected > 0) {
        tile.flour -= collected;
        state.army.inventory.flour += collected;
        note(`Loading complete: ${collected} flour aboard. Deliver it to a bakery.`);
      } else note("No flour could be loaded. Wait for milling or free flour capacity.");
    } else if (job.type === "load-bread") {
      const loaded = Math.min(amount, Math.floor(tile.bread), remainingCarry("bread"));
      if (loaded > 0) {
        tile.bread -= loaded;
        state.army.inventory.bread += loaded;
        note(`Loaded ${loaded} bread. Take it to the home treasury or spend it on an upgrade.`);
      } else note("No bread could be loaded. Wait for baking or free bread capacity.");
    }
    save(); renderAll();
  }

  function advanceProduction(dt) {
    if (!(dt > 0)) return;
    for (let i = 0; i < state.tiles.length; i++) {
      const tile = state.tiles[i];
      const owner = realOwner(tile);
      const type = realType(tile);
      const ai = isAIId(owner) ? aiById(owner) : null;
      const activeUnitPresent = owner === "you"
        ? state.army.at === i && !state.army.moving
        : Boolean(ai && ai.alive && ai.at === i && !ai.moving);
      if (owner === "npc" || !owner) continue;

      if (type === "field") {
        // Fields do not grow unattended: their owner must keep troops on the plot.
        const cap = fieldCap(tile);
        if (activeUnitPresent && tile.wheat < cap) {
          const total = tile.wheatProgress + dt;
          const produced = Math.min(cap - tile.wheat, Math.floor(total / stageSeconds(tile)));
          tile.wheat += produced;
          tile.wheatProgress = tile.wheat >= cap ? 0 : total - produced * stageSeconds(tile);
        } else if (!activeUnitPresent || tile.wheat >= cap) {
          tile.wheatProgress = tile.wheat >= cap ? 0 : tile.wheatProgress;
        }
      } else if (type === "mill") {
        const unitIdle = owner === "you"
          ? !state.army.activity
          : Boolean(ai && !ai.activity);
        const active = tile.workActive && activeUnitPresent && unitIdle;
        const cap = millFlourCap(tile);
        if (active && tile.flour < cap && tile.grain > 0) {
          const interval = stageSeconds(tile);
          const total = tile.processProgress + dt;
          const finished = Math.min(Math.floor(total / interval), Math.floor(tile.grain), Math.floor(cap - tile.flour));
          tile.grain -= finished;
          tile.flour += finished;
          tile.processProgress = tile.grain <= 0 || tile.flour >= cap ? 0 : total - finished * interval;
        } else if (tile.flour >= cap) tile.processProgress = 0;
      } else if (type === "bakery") {
        const unitIdle = owner === "you"
          ? !state.army.activity
          : Boolean(ai && !ai.activity);
        const active = tile.workActive && activeUnitPresent && unitIdle;
        const outputCap = bakeryBreadCap(tile);
        const flourCap = bakeryFlourCap(tile);
        if (active && tile.flour > 0 && tile.bread < outputCap && tile.flour <= flourCap) {
          const interval = stageSeconds(tile);
          const total = tile.bakeProgress + dt;
          const room = Math.max(0, Math.floor(outputCap - tile.bread));
          const finished = Math.min(Math.floor(total / interval), Math.floor(tile.flour), room);
          tile.flour -= finished;
          tile.bread += finished;
          tile.bakeProgress = tile.flour <= 0 || tile.bread >= outputCap ? 0 : total - finished * interval;
        } else if (tile.bread >= outputCap) tile.bakeProgress = 0;
      }
    }
  }

  function settleTimers(now) {
    if (state.army.activity && now >= state.army.activity.finishAt) finishActivity();
    if (state.army.moving && now >= state.army.moving.arriveAt) finishMarch();
  }

  function troopStrengthForAI(ai) { return ai.troops + (ai.level - 1) * 3; }

  function eliminateAI(ai, notifyPlayer = true) {
    if (!ai || !ai.alive) return;
    ai.alive = false;
    ai.moving = null;
    ai.activity = null;
    for (let i = 0; i < state.tiles.length; i++) {
      if (ownerAt(i) === ai.id) setTileOwner(i, null, 0);
    }
    if (notifyPlayer) note(`${ai.name} has been defeated. Its remaining plots are now unclaimed.`);
  }

  function aiInventory(ai, kind) { return Math.max(0, Math.floor(Number(ai.inventory[kind]) || 0)); }
  function aiCapacity(ai) { return carryCapacityFor(ai.carryLevel); }
  function aiRemaining(ai, kind) { return Math.max(0, aiCapacity(ai) - aiInventory(ai, kind)); }
  function aiOwnedIndices(ai) {
    const out = [];
    for (let i = 0; i < state.tiles.length; i++) if (ownerAt(i) === ai.id) out.push(i);
    return out;
  }
  function aiNearest(ai, predicate, options = {}) {
    let best = null, bestScore = Infinity;
    const avoid = options.avoid === undefined ? ai.lastTarget : options.avoid;
    const known = new Set(ai.knownTiles || [ai.home]);
    for (let i = 0; i < state.tiles.length; i++) {
      if (!known.has(i)) continue;
      if (i === avoid && Date.now() < (ai.targetCooldownUntil || 0)) continue;
      const tile = state.tiles[i], type = typeAt(i), owner = ownerAt(i);
      if (!predicate({ i, tile, type, owner })) continue;
      const dist = manhattan(ai.at, i);
      const ownerPenalty = owner === ai.id ? 0 : owner === null ? 2 : owner === "npc" ? 5 + (tile.guard || tile.hiddenGuard || 4) : 30;
      const score = dist + ownerPenalty;
      if (score < bestScore) { best = i; bestScore = score; }
    }
    return best;
  }
  function aiExplorationTarget(ai) {
    const known = new Set(ai.knownTiles || [ai.home]);
    let best = null, bestScore = Infinity;
    for (const knownIndex of known) {
      for (const candidate of neighbours(knownIndex)) {
        if (known.has(candidate)) continue;
        if (candidate === ai.lastTarget && Date.now() < (ai.targetCooldownUntil || 0)) continue;
        const score = manhattan(ai.at, candidate) + Math.random() * 0.15;
        if (score < bestScore) { best = candidate; bestScore = score; }
      }
    }
    return best;
  }

  function playerCanSeeTile(i) { return state.tiles[i] && state.tiles[i].type !== "fog"; }

  function startAIMarch(ai, to, objective = "expand") {
    if (!ai || !ai.alive || ai.moving || ai.at === to || to == null) return false;
    const current = state.tiles[ai.at];
    if (ai.activity) ai.activity = null;
    if (current) current.workActive = false;
    if (ownerAt(ai.at) === ai.id) setTileOwner(ai.at, ai.id, Math.max(1, Math.floor(ai.troops / 4)));
    const from = ai.at, path = routeBetween(from, to), duration = marchMs(from, to), startedAt = Date.now();
    ai.moving = { from, to, path, startedAt, arriveAt: startedAt + duration, duration, revealedSteps: path.length - 1 };
    ai.objective = objective;
    ai.lastTarget = to;
    ai.targetCooldownUntil = Date.now() + 12000;
    return true;
  }

  function finishAIMarch(ai, now) {
    const movement = ai.moving;
    if (!movement) return;
    const from = movement.from, to = movement.to;
    ai.moving = null;
    if (!Array.isArray(ai.knownTiles)) ai.knownTiles = [ai.home];
    for (const plot of movement.path) if (!ai.knownTiles.includes(plot)) ai.knownTiles.push(plot);
    const target = state.tiles[to];
    const defenderOwner = ownerAt(to);
    if (defenderOwner && defenderOwner !== ai.id) {
      const defenderAI = aiById(defenderOwner);
      const isPresentAI = defenderAI && defenderAI.alive && defenderAI.at === to && !defenderAI.moving;
      const playerPresent = defenderOwner === "you" && state.army.at === to && !state.army.moving;
      const defense = Math.max(1, isPresentAI ? troopStrengthForAI(defenderAI) : playerPresent ? troopStrength() : (target.guard || target.hiddenGuard || (defenderOwner === "npc" ? 4 : 1)));
      const attack = troopStrengthForAI(ai);
      if (attack >= defense + 2) {
        const losses = Math.min(Math.max(0, ai.troops - 1), Math.max(1, Math.ceil(defense * 0.25)));
        ai.troops -= losses;
        if (defenderAI) {
          if (typeAt(to) === "home") eliminateAI(defenderAI, false);
          else if (isPresentAI) {
            defenderAI.troops = Math.max(1, defenderAI.troops - Math.max(1, Math.ceil(attack * 0.25)));
            defenderAI.at = defenderAI.home;
            defenderAI.moving = null;
            defenderAI.activity = null;
          }
        }
        if (defenderOwner === "you") {
          if (playerPresent) {
            state.army.troops = Math.max(1, state.army.troops - Math.max(1, Math.ceil(attack * 0.25)));
            state.army.activity = null;
            state.army.moving = null;
            const fallback = state.tiles.map((_, j) => j).filter(j => j !== to && ownerAt(j) === "you").sort((a, b) => manhattan(a, to) - manhattan(b, to))[0];
            state.army.at = fallback == null ? HOME : fallback;
            state.selected = state.army.at;
          }
          // An undefended homestead can fall while the player's brigade is away too.
          if (to === HOME) state.outcome = "lost";
          if (playerCanSeeTile(to)) note(`${ai.name} captured ${typeAt(to) === "home" ? "Nana's Homestead" : META[typeAt(to)].name.toLowerCase()}. Your brigade retreated.`);
        } else if (playerCanSeeTile(to)) {
          note(`${ai.name} captured ${META[typeAt(to)].name.toLowerCase()} from ${ownerName(defenderOwner)}.`);
        }
        setTileOwner(to, ai.id, Math.max(1, Math.floor(ai.troops / 4)));
        target.workActive = false;
        ai.at = to;
      } else {
        const losses = Math.min(Math.max(0, ai.troops - 1), Math.max(1, Math.ceil(ai.troops * 0.35)));
        ai.troops -= losses;
        ai.at = from;
        ai.lastTarget = to;
        ai.targetCooldownUntil = now + 30000;
        if (playerCanSeeTile(to)) note(`${ai.name}'s attack was repelled. Its brigade lost ${losses} troops and withdrew.`);
      }
    } else {
      if (!defenderOwner) setTileOwner(to, ai.id, Math.max(1, Math.floor(ai.troops / 4)));
      ai.at = to;
    }
    if (ownerAt(ai.at) === ai.id) setTileOwner(ai.at, ai.id, Math.max(1, Math.floor(ai.troops / 4)));
    ai.nextDecisionAt = now + 900;
  }

  function startAIActivity(ai, type, amount, now) {
    if (!ai || ai.activity || ai.moving || amount <= 0) return;
    const duration = 1300 + Math.max(1, amount) * 700;
    ai.activity = { type, tileIndex: ai.at, amount, startedAt: now, finishAt: now + duration };
  }

  function finishAIActivity(ai) {
    const job = ai.activity;
    if (!job) return;
    ai.activity = null;
    if (ai.moving || ai.at !== job.tileIndex || ownerAt(job.tileIndex) !== ai.id) return;
    const tile = state.tiles[job.tileIndex];
    if (job.type === "collect-wheat") {
      const qty = Math.min(Math.floor(job.amount), Math.floor(tile.wheat), aiRemaining(ai, "wheat"));
      tile.wheat -= qty; ai.inventory.wheat += qty;
    } else if (job.type === "collect-flour") {
      const qty = Math.min(Math.floor(job.amount), Math.floor(tile.flour), aiRemaining(ai, "flour"));
      tile.flour -= qty; ai.inventory.flour += qty;
    } else if (job.type === "load-bread") {
      const qty = Math.min(Math.floor(job.amount), Math.floor(tile.bread), aiRemaining(ai, "bread"));
      tile.bread -= qty; ai.inventory.bread += qty;
    }
    ai.nextDecisionAt = Date.now() + 400;
  }

  function aiUpgradeAtHome(ai, now) {
    if (ai.at !== ai.home || ai.moving || ai.activity || ownerAt(ai.home) !== ai.id) return false;
    const stored = ai.treasury.stored;
    if (ai.level < MAX_LEVEL) {
      const cost = 7 + (ai.level - 1) * 4;
      if (stored >= cost && (ai.level < 3 || ai.troops < 14)) {
        ai.treasury.stored -= cost; ai.level++; ai.troops += 4;
        ai.nextDecisionAt = now + 1400; return true;
      }
    }
    if (ai.treasury.level < MAX_LEVEL) {
      const cost = 7 + (ai.treasury.level - 1) * 4;
      if (stored >= cost && ai.treasury.level < 4) {
        ai.treasury.stored -= cost; ai.treasury.level++;
        ai.nextDecisionAt = now + 1400; return true;
      }
    }
    return false;
  }

  function planAI(ai, now) {
    if (!ai.alive || ai.moving || ai.activity || now < ai.nextDecisionAt) return;
    ai.nextDecisionAt = now + 1700;
    if (ownerAt(ai.at) !== ai.id) {
      startAIMarch(ai, ai.home, "return to headquarters"); return;
    }
    const current = state.tiles[ai.at], type = typeAt(ai.at);
    const invBread = aiInventory(ai, "bread"), invWheat = aiInventory(ai, "wheat"), invFlour = aiInventory(ai, "flour");
    const cap = aiCapacity(ai);

    // Withdrawals and deliveries follow the same three-stage stock chain as the player.
    if (type === "home") {
      if (invBread > 0) {
        const room = Math.max(0, treasuryCapacityFor(ai.treasury.level) - ai.treasury.stored);
        const deposit = Math.min(invBread, room);
        ai.treasury.stored += deposit; ai.inventory.bread -= deposit;
      }
      if (aiUpgradeAtHome(ai, now)) return;
      if (invWheat > 0) {
        const mill = aiNearest(ai, ({ type: t, owner }) => t === "mill" && (owner === ai.id || owner === null || owner === "npc"));
        if (mill != null) { startAIMarch(ai, mill, "deliver wheat"); return; }
      }
      if (invFlour > 0) {
        const bakery = aiNearest(ai, ({ type: t, owner }) => t === "bakery" && (owner === ai.id || owner === null || owner === "npc"));
        if (bakery != null) { startAIMarch(ai, bakery, "deliver flour"); return; }
      }
    }

    if (type === "field" && ownerAt(ai.at) === ai.id) {
      if (invWheat < cap && Math.floor(current.wheat) > 0) {
        startAIActivity(ai, "collect-wheat", Math.min(Math.floor(current.wheat), cap - invWheat), now); return;
      }
      if (invWheat < cap && invBread === 0 && invFlour === 0) return; // Stay and guard the field while it grows.
    }

    if (type === "mill" && ownerAt(ai.at) === ai.id) {
      const inputRoom = Math.max(0, millInputCap(current) - Math.floor(current.grain));
      if (invWheat > 0 && inputRoom > 0) {
        const amount = Math.min(invWheat, inputRoom);
        current.grain += amount; ai.inventory.wheat -= amount; current.workActive = true; return;
      }
      if (current.grain > 0 && current.flour < millFlourCap(current)) { current.workActive = true; return; }
      if (current.flour > 0 && aiRemaining(ai, "flour") > 0) {
        startAIActivity(ai, "collect-flour", Math.min(Math.floor(current.flour), aiRemaining(ai, "flour")), now); return;
      }
    }

    if (type === "bakery" && ownerAt(ai.at) === ai.id) {
      const inputRoom = Math.max(0, bakeryFlourCap(current) - Math.floor(current.flour));
      if (invFlour > 0 && inputRoom > 0) {
        const amount = Math.min(invFlour, inputRoom);
        current.flour += amount; ai.inventory.flour -= amount; current.workActive = true; return;
      }
      if (current.flour > 0 && current.bread < bakeryBreadCap(current)) { current.workActive = true; return; }
      if (current.bread > 0 && aiRemaining(ai, "bread") > 0) {
        startAIActivity(ai, "load-bread", Math.min(Math.floor(current.bread), aiRemaining(ai, "bread")), now); return;
      }
    }

    // After an initial grace period, capable factions periodically raid the closest player-held plot.
    if (now >= ai.nextRaidAt && ai.troops >= 11) {
      const target = aiNearest(ai, ({ i, owner }) => owner === "you" && i !== ai.at, { avoid: null });
      ai.nextRaidAt = now + 180000 + Math.floor(Math.random() * 45000);
      if (target != null) { startAIMarch(ai, target, "raid the player"); return; }
    }

    if (invBread > 0) {
      if (ai.at !== ai.home) { startAIMarch(ai, ai.home, "store bread"); return; }
      if (aiRemaining(ai, "bread") > 0 && invWheat === 0 && invFlour === 0) return;
    }
    if (invWheat > 0) {
      const mill = aiNearest(ai, ({ type: t, owner }) => t === "mill" && (owner === ai.id || owner === null || owner === "npc"));
      if (mill != null && mill !== ai.at) { startAIMarch(ai, mill, "deliver wheat"); return; }
    }
    if (invFlour > 0) {
      const bakery = aiNearest(ai, ({ type: t, owner }) => t === "bakery" && (owner === ai.id || owner === null || owner === "npc"));
      if (bakery != null && bakery !== ai.at) { startAIMarch(ai, bakery, "deliver flour"); return; }
    }

    // Collect finished bread before looking for more raw material.
    if (aiRemaining(ai, "bread") > 0) {
      const stockedBakery = aiNearest(ai, ({ i, type: t, owner, tile }) => t === "bakery" && (owner === ai.id || owner === null || owner === "npc") && tile.bread > 0);
      if (stockedBakery != null && stockedBakery !== ai.at) { startAIMarch(ai, stockedBakery, "collect bread"); return; }
      if (stockedBakery === ai.at && current.bread > 0) {
        startAIActivity(ai, "load-bread", Math.min(Math.floor(current.bread), aiRemaining(ai, "bread")), now); return;
      }
    }

    // Need a source? Seek a field; then work outward through mills and bakeries.
    const field = aiNearest(ai, ({ type: t, owner }) => t === "field" && (owner === ai.id || owner === null || owner === "npc"));
    if (field != null && field !== ai.at) { startAIMarch(ai, field, "secure wheat field"); return; }
    if (type === "field" && ownerAt(ai.at) === ai.id) return;

    const missingMill = aiNearest(ai, ({ type: t, owner }) => t === "mill" && (owner === ai.id || owner === null || owner === "npc"));
    if (missingMill != null && missingMill !== ai.at) { startAIMarch(ai, missingMill, "secure a mill"); return; }
    const missingBakery = aiNearest(ai, ({ type: t, owner }) => t === "bakery" && (owner === ai.id || owner === null || owner === "npc"));
    if (missingBakery != null && missingBakery !== ai.at) { startAIMarch(ai, missingBakery, "secure a bakery"); return; }

    const frontier = aiExplorationTarget(ai);
    if (frontier != null) { startAIMarch(ai, frontier, "explore nearby plots"); return; }
  }

  function updateAI(now) {
    if (state.outcome === "lost") return;
    for (const ai of state.aiPlayers || []) {
      if (!ai.alive) continue;
      if (ai.moving && now >= ai.moving.arriveAt) finishAIMarch(ai, now);
      if (ai.activity && now >= ai.activity.finishAt) finishAIActivity(ai);
      planAI(ai, now);
    }
  }


  function availableToSpendAtCurrentTile() {
    return inventory("bread") + (state.army.at === HOME && !state.army.moving ? state.treasury.stored : 0);
  }
  function canPayHere(amount) { return !state.army.moving && availableToSpendAtCurrentTile() >= amount; }
  function payHere(amount) {
    if (!canPayHere(amount)) return false;
    const carried = Math.min(inventory("bread"), amount);
    state.army.inventory.bread -= carried;
    const rest = amount - carried;
    if (rest > 0) state.treasury.stored -= rest;
    return true;
  }

  function levelCost(tile) { return 3 + tile.level * 2; }
  function brigadeCost() { return 7 + (state.army.level - 1) * 4; }
  function carryingCost() { return 5 + (state.army.carryLevel - 1) * 3; }
  function treasuryCost() { return 7 + (state.treasury.level - 1) * 4; }

  function addAction(label, cost, callback, disabled = false, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action${danger ? " danger-action" : ""}`;
    button.disabled = disabled;
    const left = document.createElement("span");
    const right = document.createElement("span");
    left.textContent = label;
    right.textContent = cost;
    button.append(left, right);
    button.addEventListener("click", () => {
      if (button.disabled) return;
      callback();
      save();
      renderAll();
    });
    el("actions").appendChild(button);
  }

  function addHelp(text) {
    const p = document.createElement("p");
    p.className = "tiny-note";
    p.textContent = text;
    el("actions").appendChild(p);
  }

  function stopProcessing(tile, type) {
    if (!tile.workActive) return;
    tile.workActive = false;
    note(`${type} paused. Its partial progress is saved; select Start/Resume when your brigade is back here.`);
  }

  function renderActions(tile) {
    const actions = el("actions");
    actions.replaceChildren();
    const armyIsHere = state.army.at === state.selected && !state.army.moving;

    if (state.outcome === "lost") {
      addAction("Homestead captured — game over", "DEFEAT", () => {}, true, true);
      addHelp("Your bakery kingdom has fallen. Use Reset local game below to start a fresh world.");
      return;
    }

    if (state.army.moving) {
      addAction("Troops marching…", "IN TRANSIT", () => {}, true);
      addHelp("The entire brigade travels together. The map reveals each plot as the soldiers pass through it.");
      return;
    }

    if (state.army.activity) {
      if (!armyIsHere) {
        addAction("Cancel work & march here", formatTime(marchMs(state.army.at, state.selected) / 1000), () => startMarch(state.selected), false, true);
        addHelp("Leaving now cancels the current harvest/loading task. Nothing is collected until you start again.");
      } else {
        addAction("Cancel current task", "Stop", () => {
          state.army.activity = null;
          note("The soldiers stopped their task. The goods remain at this plot; start the task again when ready.");
        }, false, true);
        addHelp("A timed task completes only if your brigade stays on this plot until the timer ends.");
      }
      return;
    }

    if (!armyIsHere) {
      addAction((tile.owner === "npc" || isAIId(tile.owner)) ? `March on ${ownerName(tile.owner)}` : tile.type === "fog" ? "Explore this plot" : "March troops here", formatTime(marchMs(state.army.at, state.selected) / 1000), () => startMarch(state.selected));
      addHelp("Or drag the larger 🪖 badge from your troop stack onto a destination plot.");
      return;
    }

    if (tile.type === "fog") {
      addAction("Explore this plot", "March", () => startMarch(state.selected));
      el("tile-detail").textContent = "This plot is hidden by fog of war. March here to discover its terrain and any defenders.";
      return;
    }

    const inv = state.army.inventory;
    if (tile.type === "field" && tile.owner === "you") {
      el("tile-detail").textContent = `Wheat ready: ${Math.floor(tile.wheat)} / ${fieldCap(tile)}. Wheat grows only while your brigade is stationed here (about one unit per ${stageSeconds(tile).toFixed(0)} seconds). Harvesting takes a separate timed task. Field level ${tile.level}.`;
      const amount = Math.min(Math.floor(tile.wheat), remainingCarry("wheat"));
      if (amount > 0) addAction("Harvest wheat (timed)", `${amount} wheat`, () => startActivity("collect-wheat", amount));
      else if (remainingCarry("wheat") <= 0) addHelp(`Your wheat inventory is full (${inventory("wheat")} / ${carryCapacity()}). Deliver it to a mill first.`);
      else addHelp("The field has no wheat ready yet. Wait for it to grow.");
    } else if (tile.type === "mill" && tile.owner === "you") {
      el("tile-detail").textContent = `Wheat awaiting milling: ${Math.floor(tile.grain)} / ${millInputCap(tile)}. Flour ready: ${Math.floor(tile.flour)} / ${millFlourCap(tile)}. Each wheat becomes one flour in about ${stageSeconds(tile).toFixed(0)} seconds while your brigade works here. Mill level ${tile.level}.`;
      if (inv.wheat > 0) {
        const room = Math.max(0, millInputCap(tile) - Math.floor(tile.grain));
        const amount = Math.min(inv.wheat, room);
        addAction("Unload wheat for milling", `${amount} wheat`, () => {
          if (amount <= 0) { note("The mill's wheat queue is full. Wait for some wheat to be milled first."); return; }
          tile.grain += amount;
          state.army.inventory.wheat -= amount;
          if (tile.grain > 0 && tile.flour < millFlourCap(tile)) tile.workActive = true;
          note(`${amount} wheat unloaded. Milling starts while the brigade remains here.`);
        }, amount <= 0);
      }
      if (tile.grain > 0 && tile.flour < millFlourCap(tile)) {
        if (tile.workActive) addAction("Pause milling", "Stop work", () => stopProcessing(tile, "Milling"), false, true);
        else addAction("Start / resume milling", "Work", () => {
          tile.workActive = true;
          note(`The brigade resumed milling. Progress continues only while the soldiers stay here.`);
        });
      }
      const amount = Math.min(Math.floor(tile.flour), remainingCarry("flour"));
      if (amount > 0) addAction("Collect flour (timed)", `${amount} flour`, () => startActivity("collect-flour", amount));
      else if (tile.flour > 0 && remainingCarry("flour") <= 0) addHelp(`Your flour inventory is full (${inventory("flour")} / ${carryCapacity()}). Deliver it to a bakery first.`);
      if (tile.grain >= millInputCap(tile)) addHelp("The mill's wheat queue is full; it must refine wheat before accepting more.");
      if (tile.workActive) addHelp("Milling is active only while the brigade is on this plot. Marching away pauses it.");
    } else if (tile.type === "bakery" && tile.owner === "you") {
      el("tile-detail").textContent = `Flour waiting: ${Math.floor(tile.flour)} / ${bakeryFlourCap(tile)}. Bread ready: ${Math.floor(tile.bread)} / ${bakeryBreadCap(tile)}. Each flour makes one bread in about ${stageSeconds(tile).toFixed(0)} seconds while the brigade works here.`;
      if (inv.flour > 0) {
        const room = Math.max(0, bakeryFlourCap(tile) - Math.floor(tile.flour));
        const amount = Math.min(inv.flour, room);
        addAction("Deliver flour to bakery", `${amount} flour`, () => {
          if (amount <= 0) { note("The bakery's flour store is full. Wait for some bread to bake first."); return; }
          tile.flour += amount;
          state.army.inventory.flour -= amount;
          if (tile.flour > 0 && tile.bread < bakeryBreadCap(tile)) tile.workActive = true;
          note(`${amount} flour delivered. Baking starts while the brigade remains here; output is capped by bread storage.`);
        }, amount <= 0);
      }
      if (tile.flour > 0 && tile.bread < bakeryBreadCap(tile)) {
        if (tile.workActive) addAction("Pause baking", "Stop work", () => stopProcessing(tile, "Baking"), false, true);
        else addAction("Start / resume baking", "Work", () => {
          tile.workActive = true;
          note("The brigade resumed baking. Bread output stops at capacity; leftover flour stays in storage.");
        });
      }
      const amount = Math.min(Math.floor(tile.bread), remainingCarry("bread"));
      if (amount > 0) addAction("Load finished bread (timed)", `${amount} bread`, () => startActivity("load-bread", amount));
      else if (tile.bread > 0 && remainingCarry("bread") <= 0) addHelp(`Your bread inventory is full (${inventory("bread")} / ${carryCapacity()}). Take it home or spend it first.`);
      if (tile.bread >= bakeryBreadCap(tile) && tile.flour > 0) addHelp(`Bread storage is full. ${Math.floor(tile.flour)} flour remains unconverted until you free bread space or upgrade the bakery.`);
      if (tile.workActive) addHelp("Baking is active only while the brigade is on this plot. Marching away pauses it.");
    } else if (tile.type === "home" && tile.owner === "you") {
      el("tile-detail").textContent = `Treasury level ${state.treasury.level}/${MAX_LEVEL}: ${Math.floor(state.treasury.stored)} / ${treasuryCapacity()} bread. Two-thirds of stored bread is protected. Only bread can enter the treasury; wheat and flour stay in the brigade inventory or their buildings.`;
      if (inventory("bread") > 0) {
        const room = Math.max(0, treasuryCapacity() - Math.floor(state.treasury.stored));
        const deposit = Math.min(inventory("bread"), room);
        if (deposit > 0) addAction("Deposit bread into treasury", `${deposit} bread`, () => {
          state.treasury.stored += deposit;
          state.army.inventory.bread -= deposit;
          note(`${deposit} bread stored. Two-thirds is marked protected; the rest is exposed.`);
        });
        if (inventory("bread") > deposit) addHelp(`Treasury is full; ${inventory("bread") - deposit} bread remains with the brigade.`);
      } else if (state.treasury.stored > 0 && remainingCarry("bread") > 0) {
        const amount = Math.min(remainingCarry("bread"), Math.floor(state.treasury.stored));
        addAction("Withdraw bread for delivery", `${amount} bread`, () => {
          state.treasury.stored -= amount;
          state.army.inventory.bread += amount;
          note(`${amount} bread loaded onto the brigade. Only one-quarter of carried bread is protected.`);
        }, amount <= 0);
      }

      if (state.army.level < MAX_LEVEL) {
        const cost = brigadeCost();
        addAction(`Upgrade troop brigade to level ${state.army.level + 1}`, `${cost} bread`, () => {
          if (payHere(cost)) {
            state.army.level++;
            state.army.troops += 5;
            note(`Brigade upgraded to level ${state.army.level}: +5 guards and increased combat strength.`);
          } else note("Not enough bread in the treasury or on the brigade.");
        }, !canPayHere(cost));
      } else addHelp(`Troop brigade reached the maximum level (${MAX_LEVEL}).`);

      if (state.army.carryLevel < MAX_LEVEL) {
        const cost = carryingCost();
        addAction(`Upgrade all three carrying capacities to ${carryCapacity() + 4}`, `${cost} bread`, () => {
          if (payHere(cost)) {
            state.army.carryLevel++;
            note(`Bread, wheat, and flour carrying capacities are now ${carryCapacity()} each.`);
          } else note("Not enough bread in the treasury or on the brigade.");
        }, !canPayHere(cost));
      } else addHelp(`All three carrying capacities reached their maximum (${carryCapacity()} each).`);

      if (state.treasury.level < MAX_LEVEL) {
        const cost = treasuryCost();
        addAction(`Upgrade treasury to level ${state.treasury.level + 1}`, `${cost} bread`, () => {
          if (payHere(cost)) {
            state.treasury.level++;
            note(`Treasury capacity increased to ${treasuryCapacity()} bread. Two-thirds of stored bread is marked protected.`);
          } else note("Not enough bread in the treasury or on the brigade.");
        }, !canPayHere(cost));
      } else addHelp(`Treasury reached the maximum level (${MAX_LEVEL}).`);
    } else if (tile.type === "empty" && tile.owner === "you") {
      el("tile-detail").textContent = "An open meadow. It can be claimed and crossed, but buildings are found in their own plots and cannot be moved here.";
    } else if (tile.owner === "npc" || isAIId(tile.owner)) {
      const rival = aiById(tile.owner);
      const visibleGuard = rival && rival.alive && rival.at === state.selected && !rival.moving ? rival.troops : (tile.guard || 1);
      el("tile-detail").textContent = `${ownerName(tile.owner)} controls this ${META[tile.type].name.toLowerCase()} with an estimated ${visibleGuard} defenders. Marching here triggers combat. If you win, the plot changes hands.`;
      addHelp(rival ? "This is an active rival faction. It can scout, develop its supply chain, upgrade troops, and attack rival territories." : "A frontier outpost with static guards. Defeat its defenders to capture the plot.");
    } else {
      el("tile-detail").textContent = "Explore the hidden countryside to reveal more land, resources, and guarded outposts.";
    }

    // Site upgrades require the brigade at the site; troop, inventory-capacity and treasury upgrades are home-only.
    if (tile.owner === "you" && ["field", "mill", "bakery"].includes(tile.type)) {
      if (tile.level < MAX_LEVEL) {
        const cost = levelCost(tile);
        addAction(`Upgrade ${META[tile.type].name.toLowerCase()} to level ${tile.level + 1}`, `${cost} bread`, () => {
          if (payHere(cost)) {
            tile.level++;
            note(`${META[tile.type].name} upgraded to level ${tile.level}. Stock capacity grows and processing gets faster.`);
          } else note("Bring enough bread on the brigade to pay for this site upgrade.");
        }, !canPayHere(cost));
      } else addHelp(`${META[tile.type].name} reached the maximum level (${MAX_LEVEL}).`);
    }

    if (hasInventory("wheat")) addHelp(`Brigade inventory: ${inventory("wheat")} wheat. Unload it at a mill.`);
    if (hasInventory("flour")) addHelp(`Brigade inventory: ${inventory("flour")} flour. Deliver it to a bakery.`);
    if (hasInventory("bread") && tile.type !== "home") addHelp(`Carried bread: ${inventory("bread")} / ${carryCapacity()}. ${safeCarriedBread()} safe and ${exposedCarriedBread()} exposed.`);
  }

  function renderLog() {
    const list = el("event-log");
    list.replaceChildren();
    for (const event of state.events.slice(0, 5)) {
      const li = document.createElement("li");
      li.textContent = event;
      list.appendChild(li);
    }
  }

  function buildMap() {
    const map = el("map");
    map.replaceChildren();
    for (const i of visibleIndices()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tile";
      button.dataset.index = String(i);
      button.setAttribute("role", "gridcell");
      const icon = document.createElement("span"); icon.className = "tile-icon";
      const label = document.createElement("span"); label.className = "tile-label";
      const flag = document.createElement("span"); flag.className = "owner-flag";
      const marker = document.createElement("span"); marker.className = "army-marker"; marker.draggable = true; marker.title = "Drag the whole brigade to another plot";
      marker.innerHTML = "🪖<b>10</b>";
      const activity = document.createElement("span"); activity.className = "tile-activity";
      marker.addEventListener("dragstart", event => {
        if (state.army.moving || state.army.at !== i) { event.preventDefault(); return; }
        event.dataTransfer.setData("text/plain", "nana-army"); event.dataTransfer.effectAllowed = "move"; dropEnabled = true; refreshMap();
      });
      marker.addEventListener("dragend", () => { dropEnabled = false; document.querySelectorAll(".drop-target").forEach(n => n.classList.remove("drop-target")); refreshMap(); });
      button.append(icon, label, flag, marker, activity);
      button.addEventListener("click", () => { state.selected = i; renderAll(); });
      button.addEventListener("dragover", event => {
        if (!dropEnabled || state.army.moving || state.army.at === i) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move"; button.classList.add("drop-target");
      });
      button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
      button.addEventListener("drop", event => {
        if (!dropEnabled) return;
        event.preventDefault(); button.classList.remove("drop-target"); dropEnabled = false;
        if (state.army.moving || state.army.at === i) return;
        startMarch(i);
      });
      map.appendChild(button);
    }
    mapBuilt = true;
    renderRegionControls();
  }

  function renderRegionControls() {
    const controls = el("region-controls");
    if (!controls) return;
    controls.replaceChildren();
    for (let y = 0; y < REGION_COUNT; y++) for (let x = 0; x < REGION_COUNT; x++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `region-button${x === state.regionX && y === state.regionY ? " active" : ""}`;
      button.textContent = `${y * REGION_COUNT + x + 1}`;
      button.title = `Open Region ${y * REGION_COUNT + x + 1}${x === 1 && y === 1 ? " (Centre)" : ""}`;
      button.setAttribute("aria-label", button.title);
      button.disabled = Boolean(state.army.moving);
      button.addEventListener("click", () => {
        if (state.army.moving) return;
        state.regionX = x; state.regionY = y;
        const current = xy(state.selected);
        if (Math.floor(current.x / REGION_SIZE) !== x || Math.floor(current.y / REGION_SIZE) !== y) state.selected = idx(x * REGION_SIZE + 4, y * REGION_SIZE + 4);
        mapBuilt = false; save(); renderAll();
      });
      controls.appendChild(button);
    }
    const name = state.regionX === 1 && state.regionY === 1 ? "Centre Region" : `Region ${state.regionY * REGION_COUNT + state.regionX + 1}`;
    el("region-label").textContent = `${name} · ${state.regionY * REGION_COUNT + state.regionX + 1} of 9`;
  }

  function refreshMap() {
    if (!mapBuilt) buildMap();
    const indices = visibleIndices();
    indices.forEach((i, visibleI) => {
      const tile = state.tiles[i];
      const button = el("map").children[visibleI];
      if (!button) return;
      const hadDropTarget = button.classList.contains("drop-target");
      const meta = META[tile.type] || META.fog;
      const workingActivity = state.army.activity && state.army.activity.tileIndex === i;
      const operatingHere = state.army.at === i && !state.army.moving && !state.army.activity;
      const displayedOwner = tile.type === "fog" ? null : tile.owner;
      const aiHere = aiById(displayedOwner);
      const aiAtTile = Boolean(aiHere && aiHere.alive && aiHere.at === i);
      const aiOperatingHere = Boolean(aiAtTile && !aiHere.moving && !aiHere.activity);
      const tileIsOccupied = operatingHere || aiOperatingHere;
      const growing = tile.type === "field" && tile.owner && tile.wheat < fieldCap(tile) && tileIsOccupied;
      const milling = tile.type === "mill" && tile.workActive && tileIsOccupied && tile.grain > 0 && tile.flour < millFlourCap(tile);
      const baking = tile.type === "bakery" && tile.workActive && tileIsOccupied && tile.flour > 0 && tile.bread < bakeryBreadCap(tile);
      const working = growing || milling || baking || workingActivity;
      const effectiveOwner = tile.type === "fog" ? null : tile.owner;
      const enemyOwned = Boolean(effectiveOwner && effectiveOwner !== "you");
      button.className = `tile ${tile.type}${i === state.selected ? " selected" : ""}${!state.army.moving && state.army.at === i ? " has-army" : ""}${aiAtTile ? " has-rival" : ""}${enemyOwned ? " enemy-owned" : ""}${working ? " processing" : ""}`;
      if (dropEnabled && state.army.at !== i && !state.army.moving) button.classList.add("possible-drop");
      if (hadDropTarget) button.classList.add("drop-target");
      const owner = effectiveOwner === "you" ? "yours" : effectiveOwner ? `held by ${ownerName(effectiveOwner)}` : tile.type === "fog" ? "unexplored" : "unclaimed";
      button.setAttribute("aria-label", `${meta.name}; ${owner}`);
      button.children[0].textContent = meta.icon;
      button.children[1].textContent = tile.type === "fog" ? "UNKNOWN" : tile.type === "home" ? "HOME" : tile.type.toUpperCase();
      button.children[2].textContent = effectiveOwner === "you" ? "⚑" : effectiveOwner ? "☠" : "";
      button.children[3].innerHTML = `${aiAtTile ? "⚔️" : "🪖"}<b>${aiAtTile ? aiHere.troops : state.army.troops}</b>`;
      button.children[3].title = aiAtTile ? `${aiHere.name}'s troops` : "Drag the whole brigade to another plot";
      button.children[3].draggable = !aiAtTile && !state.army.moving && state.army.at === i;
      if (workingActivity) {
        const remaining = Math.max(0, (state.army.activity.finishAt - Date.now()) / 1000);
        button.children[4].textContent = `WORK ${Math.ceil(remaining)}s`;
      } else if (growing) button.children[4].textContent = "GROWING";
      else if (tile.type === "mill" && tile.owner && tile.grain > 0 && tile.flour < millFlourCap(tile)) button.children[4].textContent = milling ? "MILLING" : "PAUSED";
      else if (tile.type === "bakery" && tile.owner && tile.flour > 0 && tile.bread < bakeryBreadCap(tile)) button.children[4].textContent = baking ? "BAKING" : "PAUSED";
      else button.children[4].textContent = "";
    });
    renderRegionControls();
  }

  function placeTraveller() {
    const marker = el("traveller");
    const wrap = document.querySelector(".map-wrap");
    const grid = el("map");
    if (!state.army.moving) { marker.classList.remove("moving"); return; }
    const movement = state.army.moving;
    const path = movement.path;
    const ratio = Math.max(0, Math.min(1, (Date.now() - movement.startedAt) / Math.max(1, movement.duration)));
    const steps = path.length - 1;
    if (steps <= 0) { marker.classList.remove("moving"); return; }
    const segment = Math.min(steps - 1, Math.floor(ratio * steps));
    const localProgress = ratio * steps - segment;
    const aIndex = visibleIndex(path[segment]);
    const bIndex = visibleIndex(path[segment + 1]);
    if (aIndex < 0 || bIndex < 0 || !grid.children[aIndex] || !grid.children[bIndex]) { marker.classList.remove("moving"); return; }
    const a = grid.children[aIndex].getBoundingClientRect();
    const b = grid.children[bIndex].getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    const ax = a.left + a.width / 2 - r.left, ay = a.top + a.height / 2 - r.top;
    const bx = b.left + b.width / 2 - r.left, by = b.top + b.height / 2 - r.top;
    marker.style.left = `${ax + (bx - ax) * localProgress}px`;
    marker.style.top = `${ay + (by - ay) * localProgress}px`;
    el("traveller-count").textContent = String(state.army.troops);
    marker.classList.add("moving");
  }

  function renderActivity(tile) {
    const box = el("activity-box"), label = el("activity-label"), time = el("activity-time"), bar = el("activity-progress");
    let title = "Idle", progress = 0, seconds = 0, active = false;
    if (state.army.activity) {
      const job = state.army.activity;
      active = true;
      title = job.type === "collect-wheat" ? "Soldiers harvesting wheat" : job.type === "collect-flour" ? "Soldiers loading flour" : "Soldiers loading bread";
      seconds = Math.max(0, (job.finishAt - Date.now()) / 1000);
      progress = Math.max(0, Math.min(1, (Date.now() - job.startedAt) / Math.max(1, job.finishAt - job.startedAt)));
    } else if (tile.type === "field" && tile.owner === "you" && tile.wheat < fieldCap(tile)) {
      active = true; title = "Wheat growing";
      const interval = stageSeconds(tile); progress = Math.min(1, tile.wheatProgress / interval); seconds = Math.max(0, interval - tile.wheatProgress);
    } else if (tile.type === "mill" && tile.owner === "you" && tile.grain > 0 && tile.flour < millFlourCap(tile)) {
      active = tile.workActive && state.army.at === state.selected && !state.army.moving;
      title = active ? "Soldiers milling wheat into flour" : "Milling paused — start/resume work";
      const interval = stageSeconds(tile); progress = Math.min(1, tile.processProgress / interval); seconds = Math.max(0, interval - tile.processProgress);
    } else if (tile.type === "bakery" && tile.owner === "you" && tile.flour > 0 && tile.bread < bakeryBreadCap(tile)) {
      active = tile.workActive && state.army.at === state.selected && !state.army.moving;
      title = active ? "Soldiers baking bread" : "Baking paused — start/resume work";
      const interval = stageSeconds(tile); progress = Math.min(1, tile.bakeProgress / interval); seconds = Math.max(0, interval - tile.bakeProgress);
    } else if (tile.type === "mill") title = "Waiting for wheat delivery";
    else if (tile.type === "bakery") title = tile.bread >= bakeryBreadCap(tile) ? "Bakery full — collect bread" : "Waiting for flour delivery";
    else if (tile.type === "field") title = "Field ready to harvest";
    label.textContent = title;
    time.textContent = active ? formatTime(seconds) : "—";
    bar.style.width = `${Math.round(progress * 100)}%`;
    box.classList.toggle("is-active", active);
  }

  function actionSignature() {
    const t = state.tiles[state.selected];
    const a = state.army;
    return JSON.stringify([
      state.selected, a.at, a.troops, a.level, a.carryLevel,
      a.inventory.bread, a.inventory.wheat, a.inventory.flour,
      a.moving && [a.moving.from, a.moving.to, a.moving.arriveAt, a.moving.revealedSteps],
      a.activity && [a.activity.type, a.activity.tileIndex, a.activity.amount, a.activity.finishAt],
      state.treasury.stored, state.treasury.level,
      t.type, t.owner, t.guard, t.level, Math.floor(t.wheat), Math.floor(t.grain),
      Math.floor(t.flour), Math.floor(t.bread), t.workActive
    ]);
  }

  function renderAll() {
    const selected = state.tiles[state.selected];
    const meta = META[selected.type] || META.fog;
    el("bread").textContent = Math.floor(totalBread()).toLocaleString();
    el("treasury-status").textContent = `Treasury: ${Math.floor(state.treasury.stored)} / ${treasuryCapacity()}`;
    el("treasury-safe").textContent = `${safeTreasuryBread()} protected · ${exposedTreasuryBread()} exposed`;
    el("troops").textContent = state.army.troops.toLocaleString();
    el("army-level").textContent = `Brigade level ${state.army.level}/${MAX_LEVEL}`;
    el("inv-bread").textContent = `${inventory("bread")} / ${carryCapacity()}`;
    el("inv-wheat").textContent = `${inventory("wheat")} / ${carryCapacity()}`;
    el("inv-flour").textContent = `${inventory("flour")} / ${carryCapacity()}`;
    el("capacity").textContent = `Each resource has its own capacity of ${carryCapacity()} units.`;
    el("carried-safe").textContent = `Carried bread: ${safeCarriedBread()} safe · ${exposedCarriedBread()} exposed`;
    el("land").textContent = ownedTiles().length.toLocaleString();
    el("production-status").textContent = countOwned("field") && countOwned("mill") && countOwned("bakery") ? "Manual supply chain ready" : "Explore to expand supply chain";
    const enemyStatus = el("enemy-status");
    if (enemyStatus) {
      const alive = (state.aiPlayers || []).filter(a => a.alive);
      enemyStatus.textContent = state.outcome === "lost"
        ? "DEFEAT: your homestead has fallen. Reset the local game to try a new kingdom."
        : alive.length ? `${alive.length} rival baker factions are active beyond the fog. They scout, develop supply chains, upgrade, and may raid your holdings.` : "All rival baker factions have been defeated.";
    }
    el("tile-icon").textContent = meta.icon;
    el("tile-title").textContent = meta.name;
    el("tile-description").textContent = meta.desc;
    el("tile-owner").textContent = selected.owner === "you" ? "You" : (selected.owner === "npc" || isAIId(selected.owner)) ? ownerName(selected.owner) : selected.type === "fog" ? "Unknown" : "Unclaimed";
    const selectedRival = aiById(selected.owner);
    const selectedGuard = selectedRival && selectedRival.alive && selectedRival.at === state.selected && !selectedRival.moving ? selectedRival.troops : selected.guard;
    el("tile-garrison").textContent = (selected.owner === "npc" || isAIId(selected.owner)) ? `${Math.max(1, selectedGuard || 0)} defenders` : selected.type === "fog" ? "Unknown" : selected.type === "home" ? "Headquarters" : "No guards";
    const currentTile = state.tiles[state.army.at];
    el("army-position").textContent = state.army.moving ? `Marching to plot ${xy(state.army.moving.to).x + 1}, ${xy(state.army.moving.to).y + 1}` : META[currentTile.type].name;
    const c = xy(state.selected);
    el("coords").textContent = `Plot ${c.x % REGION_SIZE + 1}, ${c.y % REGION_SIZE + 1} · World ${c.x + 1}, ${c.y + 1}`;
    if (state.army.activity) el("map-status").textContent = `${state.army.activity.type.replaceAll("-", " ")} — ${formatTime((state.army.activity.finishAt - Date.now()) / 1000)} remaining`;
    else if (state.army.moving) el("map-status").textContent = `On the march — ${formatTime((state.army.moving.arriveAt - Date.now()) / 1000)} remaining`;
    else if (hasAnyInventory()) el("map-status").textContent = `Carrying ${inventory("bread")} bread, ${inventory("wheat")} wheat, ${inventory("flour")} flour.`;
    else el("map-status").textContent = "No cargo aboard.";
    renderActivity(selected);
    el("notice").textContent = message;
    el("leaderboard-bread").textContent = Math.floor(totalBread()).toLocaleString();
    const signature = actionSignature();
    if (signature !== lastActionSignature) {
      renderActions(selected);
      lastActionSignature = signature;
    }
    renderLog();
    refreshMap();
    placeTraveller();
  }

  function frame() {
    const now = Date.now();
    const elapsed = Math.min(2592000, Math.max(0, (now - state.lastTick) / 1000));
    state.lastTick = now;
    revealMovementProgress();
    advanceProduction(elapsed);
    settleTimers(now);
    updateAI(now);
    if (now - lastDraw > 250) { renderAll(); lastDraw = now; }
    placeTraveller();
    if (now - lastStored > 2000) { save(); lastStored = now; }
    window.setTimeout(frame, 150);
  }

  buildMap();


  el("reset").addEventListener("click", () => el("reset-dialog").showModal());
  el("cancel-reset").addEventListener("click", () => el("reset-dialog").close());
  el("confirm-reset").addEventListener("click", () => {
    state = newGame();
    message = "A fresh kingdom! Only Nana’s Homestead is revealed; rival factions are active beyond the fog.";
    lastActionSignature = "";
    save();
    el("reset-dialog").close();
    renderAll();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      const now = Date.now();
      const elapsed = Math.min(2592000, Math.max(0, (now - state.lastTick) / 1000));
      state.lastTick = now;
      revealMovementProgress();
      advanceProduction(elapsed);
      settleTimers(now);
      updateAI(now);
      save();
      renderAll();
    }
  });

  // Local save v7 is separate from earlier prototypes. Field growth requires troops
  // on the field; milling and baking progress only while the controlling brigade stays.
  const initialNow = Date.now();
  const offlineElapsed = Math.min(2592000, Math.max(0, (initialNow - state.lastTick) / 1000));
  state.lastTick = initialNow;
  revealMovementProgress();
  advanceProduction(offlineElapsed);
  settleTimers(initialNow);
  updateAI(initialNow);
  renderAll();
  frame();
})();
