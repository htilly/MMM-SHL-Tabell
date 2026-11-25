"use strict";

/* Tests for node_helper's degraded paths — the ones that decide whether the
 * wall shows a stale table or an empty one.
 *
 * node_helper.js requires MagicMirror's own "node_helper" and "logger"
 * modules, which only exist inside a running mirror, so we intercept those two
 * requires and hand it stand-ins. Everything else under test is the real code.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

const MODULE_DIR = path.join(__dirname, "..");

const SEASON = { uuid: "qa98unlbd6", seasonCode: "2026", seriesCode: "SHL", label: "SHL 2026/2027" };

const CACHED_STATE = {
	ok: true,
	fetchedAt: Date.parse("2026-11-24T17:13:27.939Z"),
	season: SEASON,
	standings: [
		{ rank: 1, teamId: "FBK", display: "Färjestad", gp: 18, points: 47 },
		{ rank: 2, teamId: "FHC", display: "Frölunda", gp: 20, points: 41 }
	],
	games: [],
	error: null
};

/** A fresh helper instance with MagicMirror's modules stubbed out. */
function loadHelper() {
	const sent = [];
	const warnings = [];
	const errors = [];

	const realLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "node_helper") {
			return {
				create: (spec) =>
					Object.assign(
						{
							name: "MMM-SHL-Tabell",
							sendSocketNotification: (n, p) => sent.push({ notification: n, payload: p })
						},
						spec
					)
			};
		}
		if (request === "logger") {
			return {
				info: () => {},
				warn: (m) => warnings.push(String(m)),
				error: (m) => errors.push(String(m))
			};
		}
		return realLoad.apply(this, arguments);
	};

	let helper;
	try {
		delete require.cache[require.resolve(path.join(MODULE_DIR, "node_helper.js"))];
		helper = require(path.join(MODULE_DIR, "node_helper.js"));
	} finally {
		Module._load = realLoad;
	}

	const api = require(path.join(MODULE_DIR, "lib/api.js"));
	return { helper, api, sent, warnings, errors };
}

/** Point the helper's cache at a scratch dir, optionally pre-seeded. */
function withCache(helper, state) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shl-cache-"));
	if (state) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
	helper.cacheFile = (name) => path.join(dir, `${name}.json`);
	return dir;
}

/** Make every network call reject, as if shl.se were unreachable. */
function breakNetwork(api, only) {
	const names = only || [
		"fetchSsgt",
		"fetchStandings",
		"fetchTodayGames",
		"fetchNextGameDay",
		"fetchLiveUuids",
		"fetchGameOverview"
	];
	for (const name of names) {
		api[name] = async () => {
			throw new Error("simulated network failure");
		};
	}
}

function lastPayload(sent) {
	assert.ok(sent.length > 0, "helper sent no notification at all");
	return sent[sent.length - 1].payload;
}

test("the saved table is served from disk before any network call", async () => {
	const { helper, api, sent } = loadHelper();
	helper.start();
	withCache(helper, CACHED_STATE);
	breakNetwork(api);
	helper.schedule = () => {};

	await helper.socketNotificationReceived("SHL_SUBSCRIBE", { idleInterval: 1800000 });

	// The very first notification must already carry the table: on a cold boot
	// the mirror should never show an empty frame while waiting for shl.se.
	assert.strictEqual(sent[0].payload.standings.length, 2);
	assert.strictEqual(sent[0].payload.standings[0].display, "Färjestad");
});

test("a failed fetch keeps the last good table and flags it, rather than blanking", async () => {
	const { helper, api, sent, warnings } = loadHelper();
	helper.start();
	withCache(helper, CACHED_STATE);
	breakNetwork(api);
	helper.schedule = () => {};

	await helper.socketNotificationReceived("SHL_SUBSCRIBE", { idleInterval: 1800000 });
	await helper.run();

	const payload = lastPayload(sent);
	assert.strictEqual(payload.ok, false);
	assert.match(payload.error.message, /simulated network failure/);
	assert.strictEqual(payload.standings.length, 2, "standings were dropped on failure");
	assert.strictEqual(payload.standings[0].points, 47);
	// fetchedAt must still point at the last SUCCESS, so "senast uppdaterad"
	// and the staleness warning describe the data rather than the attempt.
	assert.strictEqual(payload.fetchedAt, CACHED_STATE.fetchedAt);
	assert.ok(
		warnings.some((w) => /visar sparad tabell/.test(w)),
		"expected a warning that the saved table is being shown"
	);
});

test("a cold start with no cache and no network reports empty without throwing", async () => {
	const { helper, api, sent, errors } = loadHelper();
	helper.start();
	withCache(helper, null);
	breakNetwork(api);
	helper.schedule = () => {};

	await helper.socketNotificationReceived("SHL_SUBSCRIBE", { idleInterval: 1800000 });
	await helper.run();

	const payload = lastPayload(sent);
	assert.strictEqual(payload.ok, false);
	assert.deepStrictEqual(payload.standings, []);
	assert.strictEqual(payload.fetchedAt, null);
	assert.ok(errors.length > 0, "a cold start failure should be logged as an error");
});

test("a flaky latest-ssgt falls back to the known season instead of losing the refresh", async () => {
	const { helper, api, warnings } = loadHelper();
	helper.start();
	helper.config = {};
	withCache(helper, CACHED_STATE);
	helper.state = { ...CACHED_STATE };
	// Only the season lookup fails; the rest of the API is fine.
	breakNetwork(api, ["fetchSsgt"]);
	helper.schedule = () => {};

	const ssgt = await helper.currentSsgt();

	assert.strictEqual(ssgt.uuid, SEASON.uuid, "should reuse the season uuid from the cache");
	assert.ok(
		warnings.some((w) => /latest-ssgt/.test(w)),
		"the fallback should be visible in the log, not silent"
	);
	// Not stamped as fresh: the next poll must try the real lookup again.
	assert.strictEqual(helper.ssgtAt, 0);
});

test("latest-ssgt failing with no known season at all still surfaces the error", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = {};
	withCache(helper, null);
	breakNetwork(api, ["fetchSsgt"]);

	await assert.rejects(() => helper.currentSsgt(), /simulated network failure/);
});

/* ------------------------------------------------------- the stale footnote */

/**
 * Load the front-end module and hand back the registered spec.
 *
 * MMM-SHL-Tabell.js calls Module.register at load time and leans on the
 * globals MagicMirror provides, so we supply just enough of them to get at the
 * spec's pure methods. No DOM is touched by footNote().
 */
function loadFrontEnd() {
	let spec = null;
	global.Module = { register: (_name, definition) => (spec = definition) };
	global.Log = { warn: () => {}, info: () => {}, error: () => {} };
	global.ShlCore = require(path.join(MODULE_DIR, "shl-core.js"));
	delete require.cache[require.resolve(path.join(MODULE_DIR, "MMM-SHL-Tabell.js"))];
	require(path.join(MODULE_DIR, "MMM-SHL-Tabell.js"));
	assert.ok(spec, "MMM-SHL-Tabell.js did not register a module");
	spec.config = { ...spec.defaults };
	return spec;
}

test("fresh data gets a plain 'senast uppdaterad' stamp", () => {
	const mod = loadFrontEnd();
	mod.payload = { fetchedAt: Date.now() - 5 * 60 * 1000, error: null };
	const note = mod.footNote();
	assert.strictEqual(note.stale, false);
	assert.match(note.text, /^Senast uppdaterad \d{2}[:.]\d{2}$/);
});

test("an old table is warned about even when no error was recorded", () => {
	// The quiet failure: the helper stopped sending, so nothing ever set
	// error, but the table on the wall is hours old. It must say so.
	const mod = loadFrontEnd();
	mod.payload = { fetchedAt: Date.now() - 5 * 60 * 60 * 1000, error: null };
	const note = mod.footNote();
	assert.strictEqual(note.stale, true);
	assert.match(note.text, /Ingen ny data/);
});

test("an old table with a fetch error names shl.se as the reason", () => {
	const mod = loadFrontEnd();
	mod.payload = { fetchedAt: Date.now() - 5 * 60 * 60 * 1000, error: { message: "boom" } };
	const note = mod.footNote();
	assert.strictEqual(note.stale, true);
	assert.match(note.text, /Når inte shl\.se/);
});

test("a table more than a day old is stamped with a date, not just a time", () => {
	const mod = loadFrontEnd();
	mod.payload = { fetchedAt: Date.now() - 30 * 60 * 60 * 1000, error: null };
	const note = mod.footNote();
	assert.strictEqual(note.stale, true);
	// A bare "från 17:13" would read as today; the date removes that trap.
	assert.match(note.text, /\d+ \w+/);
});

test("showUpdated: false means no footnote at all", () => {
	const mod = loadFrontEnd();
	mod.config.showUpdated = false;
	mod.payload = { fetchedAt: Date.now() - 5 * 60 * 60 * 1000, error: null };
	assert.strictEqual(mod.footNote(), null);
});

test("no fetchedAt yet means no footnote rather than a broken one", () => {
	const mod = loadFrontEnd();
	mod.payload = { fetchedAt: null, error: { message: "boom" } };
	assert.strictEqual(mod.footNote(), null);
});

/* --------------------------------------------- self-healing re-subscription */

/** A front-end instance that records the notifications it would send. */
function frontEndWithSocket() {
	const mod = loadFrontEnd();
	mod.sent = [];
	mod.sendSocketNotification = (n, p) => mod.sent.push({ notification: n, payload: p });
	mod.updateDom = () => {};
	return mod;
}

test("a live helper is not re-subscribed to", () => {
	const mod = frontEndWithSocket();
	mod.heardAt = Date.now();
	mod.subscribedAt = Date.now();
	mod.payload = { fetchedAt: Date.now(), standings: [] };

	mod.resubscribeIfStarved();

	assert.strictEqual(mod.sent.length, 0, "re-subscribed to a helper that is answering");
});

test("a helper that has gone silent is re-subscribed to", () => {
	// The server-restart trap: socket.io reconnected, but start() never re-ran,
	// so the new helper process is sitting there having never been subscribed.
	const mod = frontEndWithSocket();
	const longAgo = Date.now() - 3 * 60 * 60 * 1000;
	mod.heardAt = longAgo;
	mod.subscribedAt = longAgo;
	mod.payload = { fetchedAt: longAgo, standings: [] };

	mod.resubscribeIfStarved();

	assert.strictEqual(mod.sent.length, 1);
	assert.strictEqual(mod.sent[0].notification, "SHL_SUBSCRIBE");
});

test("a failing-but-alive helper is left alone", () => {
	// fetchedAt is old because shl.se is down, but the helper is still talking
	// to us. Re-subscribing would achieve nothing, so we must not.
	const mod = frontEndWithSocket();
	mod.heardAt = Date.now();
	mod.subscribedAt = Date.now() - 3 * 60 * 60 * 1000;
	mod.payload = { fetchedAt: Date.now() - 3 * 60 * 60 * 1000, error: { message: "down" }, standings: [] };

	mod.resubscribeIfStarved();

	assert.strictEqual(mod.sent.length, 0, "re-subscribed despite the helper being alive");
});

test("a just-subscribed module does not immediately re-subscribe", () => {
	// No payload has arrived yet on a cold start; the pending subscribe must be
	// given time rather than being resent every single minute.
	const mod = frontEndWithSocket();
	mod.heardAt = 0;
	mod.subscribedAt = Date.now();
	mod.payload = null;

	mod.resubscribeIfStarved();

	assert.strictEqual(mod.sent.length, 0);
});

test("suspend stops the redraw and resume restarts it", () => {
	const mod = frontEndWithSocket();
	let redraws = 0;
	mod.updateDom = () => redraws++;
	mod.payload = { fetchedAt: Date.now(), standings: [] };

	mod.suspend();
	assert.strictEqual(mod.suspended, true);
	mod.resume();
	assert.strictEqual(mod.suspended, false);
	assert.strictEqual(redraws, 1, "resume should redraw so the stamp is not stale on return");
});

test("a successful fetch writes the table to disk for the next cold start", async () => {
	const { helper, api, sent } = loadHelper();
	helper.start();
	const dir = withCache(helper, null);
	helper.schedule = () => {};

	api.fetchSsgt = async () => SEASON;
	api.fetchStandings = async () => ({
		leagueStandings: [
			{
				Rank: 1,
				GP: 18,
				W: 14,
				OTW: 2,
				OTL: 1,
				L: 1,
				G: 67,
				GA: 24,
				Diff: 43,
				Points: 47,
				info: { teamInfo: { teamId: "FBK", teamNames: { code: "FBK", short: "Färjestad", long: "Färjestad BK" } } }
			}
		]
	});
	api.fetchTodayGames = async () => [];
	api.fetchNextGameDay = async () => [];
	api.fetchLiveUuids = async () => [];

	await helper.socketNotificationReceived("SHL_SUBSCRIBE", { idleInterval: 1800000 });
	await helper.run();

	const payload = lastPayload(sent);
	assert.strictEqual(payload.ok, true);
	assert.strictEqual(payload.standings[0].display, "Färjestad");

	const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
	assert.strictEqual(onDisk.standings[0].points, 47);
	assert.strictEqual(onDisk.season.uuid, SEASON.uuid);
});

/** Render the table with a bare-bones DOM; returns each row's cell texts. */
function tableCells(showAllStats) {
	const mod = loadFrontEnd();
	if (showAllStats !== undefined) mod.config.showAllStats = showAllStats;
	mod.config.showLogos = false;
	mod.payload = {
		standings: [
			{ rank: 1, teamId: "x", display: "X", gp: 18, w: 14, otw: 2, otl: 1, l: 1, gf: 67, ga: 24, diff: 43, points: 47 }
		]
	};
	mod.el = (_tag, _cls, text) => ({
		text,
		children: [],
		appendChild(child) {
			this.children.push(child);
		}
	});
	return mod.renderTable(null).children.map((row) => row.children.map((c) => c.text));
}

test("showAllStats: true shows every stat", () => {
	const [head, row] = tableCells(true);
	assert.deepStrictEqual(head, ["", "Lag", "M", "V", "ÖTV", "ÖTF", "F", "MÅL", "+/-", "P"]);
	assert.deepStrictEqual(row.slice(2), ["18", "14", "2", "1", "1", "67–24", "+43", "47"]);
});

test("only +/- and points are shown by default", () => {
	const [head, row] = tableCells();
	assert.deepStrictEqual(head, ["", "Lag", "+/-", "P"]);
	assert.deepStrictEqual(row.slice(2), ["+43", "47"]);
});

/* -------------------------------------------------------------- events */

const FAV_GAME = () => ({ uuid: "g1", live: true, home: { teamId: "FBK" }, away: { teamId: "FHC" } });

test("events are fetched for the favourite's live game only", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = { eventsFor: "FBK" };
	const asked = [];
	api.fetchPlayByPlay = async (uuid) => {
		asked.push(uuid);
		return [{ type: "goal", period: 1, time: "01:00", homeGoals: 1, awayGoals: 0 }];
	};
	const fav = FAV_GAME();
	const other = { uuid: "g2", live: true, home: { teamId: "LHF" }, away: { teamId: "MIF" } };
	await helper.loadEvents([other, fav], CACHED_STATE.standings);
	await helper.loadEvents([{ ...FAV_GAME(), live: false }], CACHED_STATE.standings);
	assert.deepStrictEqual(asked, ["g1"]);
	assert.strictEqual(fav.events.length, 1);
	assert.strictEqual(other.events, undefined);
});

test("no events are fetched when they are switched off", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = { eventsFor: "" };
	api.fetchPlayByPlay = async () => assert.fail("should not fetch");
	await helper.loadEvents([FAV_GAME()], CACHED_STATE.standings);
});

test("a failed events fetch keeps the previous events and does not throw", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = { eventsFor: "FBK" };
	helper.state = { games: [{ uuid: "g1", events: [{ type: "goal" }] }] };
	api.fetchPlayByPlay = async () => {
		throw new Error("boom");
	};
	const fav = FAV_GAME();
	await helper.loadEvents([fav], CACHED_STATE.standings);
	assert.deepStrictEqual(fav.events, [{ type: "goal" }]);
});

/* ------------------------------------------------------- next game day */

const rawGame = (uuid, start, home, away) => ({
	uuid,
	startDateTime: start,
	state: "pre-game",
	homeTeamInfo: { code: home, names: { code: home } },
	awayTeamInfo: { code: away, names: { code: away } }
});

test("tomorrow's games are added after today's, flagged, without duplicates", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = {};
	let nextDayCalls = 0;
	api.fetchTodayGames = async () => [rawGame("a", "2026-11-25T18:00:00Z", "LHF", "MIF")];
	api.fetchNextGameDay = async () => {
		nextDayCalls++;
		return { games: [rawGame("a", "2026-11-25T18:00:00Z", "LHF", "MIF"), rawGame("b", "2026-11-26T18:00:00Z", "TIK", "FBK")] };
	};
	api.fetchLiveUuids = async () => [];

	const games = await helper.loadGames("s");
	assert.deepStrictEqual(games.map((g) => [g.uuid, Boolean(g.upcomingDay)]), [["a", false], ["b", true]]);

	await helper.loadGames("s");
	assert.strictEqual(nextDayCalls, 1, "next-game-day is not refetched on every poll");
});

test("a failing next-game-day costs the reminder, not today's games", async () => {
	const { helper, api } = loadHelper();
	helper.start();
	helper.config = {};
	api.fetchTodayGames = async () => [rawGame("a", "2026-11-25T18:00:00Z", "LHF", "MIF")];
	api.fetchNextGameDay = async () => {
		throw new Error("boom");
	};
	api.fetchLiveUuids = async () => [];
	const games = await helper.loadGames("s");
	assert.deepStrictEqual(games.map((g) => g.uuid), ["a"]);
});
