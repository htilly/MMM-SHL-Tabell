"use strict";

const test = require("node:test");
const assert = require("node:assert");
const core = require("../shl-core.js");

/* Shapes below are copied from live responses on 2026-11-24. */

const standingsPayload = {
	leagueStandings: [
		{
			Rank: 1,
			GP: 18,
			W: 14,
			OTW: 2,
			L: 1,
			OTL: 1,
			G: 67,
			GA: 24,
			Diff: 43,
			Points: 47,
			info: {
				code: "Färjestad",
				teamId: "FBK",
				teamInfo: {
					teamId: "FBK",
					teamMedia: "https://example.invalid/fbk.svg",
					teamNames: { code: "FBK", short: "Färjestad", long: "Färjestad BK" }
				}
			}
		},
		{
			Rank: 2,
			GP: 18,
			W: 12,
			OTW: 1,
			L: 4,
			OTL: 1,
			G: 55,
			GA: 38,
			Diff: 17,
			Points: 41,
			info: {
				code: "Örebro",
				teamId: "OHK",
				teamInfo: {
					teamId: "OHK",
					// The API disagrees with itself here: teamId OHK, names.code ÖRE.
					teamNames: { code: "ÖRE", short: "Örebro", long: "Örebro Hockey" }
				}
			}
		},
		{
			Rank: 3,
			GP: 18,
			W: 10,
			OTW: 0,
			L: 8,
			OTL: 0,
			G: 44,
			GA: 44,
			Diff: 0,
			Points: 30,
			info: {
				code: "Frölunda",
				teamId: "FHC",
				// Note the trailing space, exactly as the feed ships it.
				teamInfo: { teamId: "FHC", teamNames: { code: "FHC", short: "Frölunda ", long: "Frölunda HC" } }
			}
		}
	]
};

const todayGames = [
	{
		uuid: "mqhq8jocap",
		startDateTime: "2026-11-24T18:00:00.000Z",
		state: "pre-game",
		overtime: false,
		shootout: false,
		homeTeamInfo: { code: "LHF", score: "N/A", names: { code: "LHF", short: "Luleå", long: "Luleå Hockey" } },
		awayTeamInfo: { code: "MIF", score: "N/A", names: { code: "MIF", short: "Malmö", long: "Malmö Redhawks" } },
		venueInfo: { name: "Coop Norrbotten Arena" }
	},
	{
		uuid: "yaymmo31d1",
		startDateTime: "2026-11-24T18:00:00.000Z",
		state: "pre-game",
		overtime: false,
		shootout: false,
		homeTeamInfo: { code: "OHK", score: "N/A", names: { code: "ÖRE", short: "Örebro", long: "Örebro Hockey" } },
		awayTeamInfo: { code: "FHC", score: "N/A", names: { code: "FHC", short: "Frölunda ", long: "Frölunda HC" } },
		venueInfo: { name: "Behrn Arena" }
	}
];

const START = Date.parse("2026-11-24T18:00:00.000Z");

/* ---------------------------------------------------------- standings */

test("mapStandings flattens rows and sorts by rank", () => {
	const rows = core.mapStandings(standingsPayload);
	assert.equal(rows.length, 3);
	assert.equal(rows[0].teamId, "FBK");
	assert.equal(rows[0].points, 47);
	assert.equal(rows[0].diff, 43);
	assert.equal(rows[0].display, "Färjestad");
	assert.equal(rows[2].display, "Frölunda", "trailing whitespace is trimmed");
});

test("mapStandings survives an empty or malformed payload", () => {
	assert.deepEqual(core.mapStandings(null), []);
	assert.deepEqual(core.mapStandings({}), []);
	assert.deepEqual(core.mapStandings({ leagueStandings: "nope" }), []);
});

/* ------------------------------------------------------ favourite team */

test("favourite matches on code, regardless of case", () => {
	const teams = core.mapStandings(standingsPayload);
	for (const input of ["FBK", "fbk", " Fbk "]) {
		assert.equal(core.resolveFavourite(teams, input).teamId, "FBK", input);
	}
});

test("favourite matches on short and long name", () => {
	const teams = core.mapStandings(standingsPayload);
	assert.equal(core.resolveFavourite(teams, "Färjestad").teamId, "FBK");
	assert.equal(core.resolveFavourite(teams, "färjestad bk").teamId, "FBK");
	assert.equal(core.resolveFavourite(teams, "Frölunda").teamId, "FHC");
});

test("favourite matches Örebro by either of its two codes", () => {
	const teams = core.mapStandings(standingsPayload);
	assert.equal(core.resolveFavourite(teams, "OHK").teamId, "OHK");
	assert.equal(core.resolveFavourite(teams, "ÖRE").teamId, "OHK");
});

test("no favourite configured is not an error", () => {
	const teams = core.mapStandings(standingsPayload);
	for (const input of ["", "   ", null, undefined]) {
		const r = core.resolveFavourite(teams, input);
		assert.equal(r.teamId, null);
		assert.equal(r.unmatched, undefined, "an empty value is a choice, not a mistake");
	}
});

test("an unrecognised favourite reports itself without throwing", () => {
	const teams = core.mapStandings(standingsPayload);
	const r = core.resolveFavourite(teams, "AIK");
	assert.equal(r.teamId, null);
	assert.equal(r.unmatched, "AIK");
});

/* ------------------------------------------------------------- games */

test("mapGames reads scores and start times", () => {
	const games = core.mapGames(todayGames);
	assert.equal(games.length, 2);
	assert.equal(games[0].home.display, "Luleå");
	assert.equal(games[0].start, START);
	assert.equal(games[0].home.score, null, '"N/A" is not a score');
});

test("a game is live only once it has started and the league says so", () => {
	const before = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START - 60 * 60 * 1000);
	assert.equal(before[0].live, false, "listed as upcoming, but puck has not dropped");

	const during = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + 20 * 60 * 1000);
	assert.equal(during[0].live, true);
	assert.equal(during[1].live, false, "not in the live list");
});

test("a finished game is never live, even if still listed", () => {
	const games = core.mapGames(todayGames);
	const overviews = { mqhq8jocap: { state: "post_game", homeGoals: 4, awayGoals: 1, time: {} } };
	const out = core.applyLive(games, ["mqhq8jocap"], overviews, START + 3 * 60 * 60 * 1000);
	assert.equal(out[0].live, false);
	assert.equal(out[0].state, "post-game");
	assert.equal(out[0].home.score, 4);
});

test("live scores come from the overview", () => {
	const overviews = { mqhq8jocap: { state: "Ongoing", homeGoals: 2, awayGoals: 1, time: { period: 2, periodTime: "12:34" } } };
	const out = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], overviews, START + 30 * 60 * 1000);
	assert.equal(out[0].home.score, 2);
	assert.equal(out[0].away.score, 1);
	assert.equal(core.liveLabel(out[0]), "P2 12:34");
});

test("an empty or unfamiliar time object degrades to a bare LIVE", () => {
	assert.deepEqual(core.readGameTime({}), { period: null, clock: null });
	assert.deepEqual(core.readGameTime(null), { period: null, clock: null });
	assert.deepEqual(core.readGameTime({ somethingNew: 7 }), { period: null, clock: null });
	assert.equal(core.liveLabel({ period: null, clock: null }), "LIVE");
	assert.equal(core.liveLabel({ period: "3", clock: null }), "P3");
	assert.equal(core.liveLabel({ period: "Förlängning", clock: "02:11" }), "Förlängning 02:11");
});

/* -------------------------------------------------------- live panel */

test('liveGames "off" never shows a panel', () => {
	const games = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + MIN(30));
	assert.deepEqual(core.selectLiveGames(games, "FHC", "off"), []);
});

test('liveGames "favorite" shows only the favourite\'s game', () => {
	const games = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + MIN(30));
	const picked = core.selectLiveGames(games, "FHC", "favorite");
	assert.equal(picked.length, 1);
	assert.equal(picked[0].uuid, "yaymmo31d1", "Frölunda's game, not the one in progress");
});

test('liveGames "favorite" shows nothing when the favourite is not playing', () => {
	const games = core.applyLive(core.mapGames(todayGames), [], {}, START);
	assert.deepEqual(core.selectLiveGames(games, "FBK", "favorite"), []);
});

test('liveGames "favorite" with no favourite set shows nothing rather than everything', () => {
	const games = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + MIN(30));
	assert.deepEqual(core.selectLiveGames(games, null, "favorite"), []);
	assert.deepEqual(core.selectLiveGames(games, "", "favorite"), []);
});

test('liveGames "all" prefers games in progress, else tonight\'s fixtures', () => {
	const live = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + MIN(30));
	assert.deepEqual(
		core.selectLiveGames(live, null, "all").map((g) => g.uuid),
		["mqhq8jocap"]
	);

	const upcoming = core.applyLive(core.mapGames(todayGames), [], {}, START - MIN(60));
	assert.equal(core.selectLiveGames(upcoming, null, "all").length, 2);
});

test("no games at all means no panel, in every mode", () => {
	for (const mode of ["favorite", "all", "off"]) {
		assert.deepEqual(core.selectLiveGames([], "FBK", mode), [], mode);
		assert.deepEqual(core.selectLiveGames(null, "FBK", mode), [], mode);
	}
});

/* ------------------------------------------------------------ polling */

const opts = { liveInterval: MIN(1), gamedayInterval: MIN(10), idleInterval: MIN(30), preGameLead: MIN(20) };

test("polling is slow when there is no hockey", () => {
	assert.equal(core.nextPollDelay([], opts, START), MIN(30));
});

test("polling speeds up near puck drop and during play", () => {
	const idle = core.applyLive(core.mapGames(todayGames), [], {}, START - MIN(120));
	assert.equal(core.nextPollDelay(idle, opts, START - MIN(120)), MIN(10), "games today, but hours away");

	const soon = core.applyLive(core.mapGames(todayGames), [], {}, START - MIN(10));
	assert.equal(core.nextPollDelay(soon, opts, START - MIN(10)), MIN(1));

	const live = core.applyLive(core.mapGames(todayGames), ["mqhq8jocap"], {}, START + MIN(30));
	assert.equal(core.nextPollDelay(live, opts, START + MIN(30)), MIN(1));
});

test("polling slows back down once every game has finished", () => {
	const overviews = {
		mqhq8jocap: { state: "post_game", homeGoals: 3, awayGoals: 2, time: {} },
		yaymmo31d1: { state: "post_game", homeGoals: 1, awayGoals: 4, time: {} }
	};
	const done = core.applyLive(core.mapGames(todayGames), [], overviews, START + MIN(200));
	assert.equal(core.nextPollDelay(done, opts, START + MIN(200)), MIN(10));
});

/* ---------------------------------------------------------- formatting */

test("formatDiff signs positives", () => {
	assert.equal(core.formatDiff(43), "+43");
	assert.equal(core.formatDiff(0), "0");
	assert.equal(core.formatDiff(-7), "-7");
});

test("formatTime renders Stockholm time", () => {
	assert.equal(core.formatTime(START, "Europe/Stockholm"), "19:00");
	assert.equal(core.formatTime(null, "Europe/Stockholm"), "");
});

function MIN(n) {
	return n * 60 * 1000;
}

/* ---------------------------------------------------------------- zones */

test("zoneFor maps ranks to qualification zones", () => {
	const zones = { playoff: 6, playin: 10, relegation: 14 };
	assert.equal(core.zoneFor(1, zones), "playoff");
	assert.equal(core.zoneFor(6, zones), "playoff");
	assert.equal(core.zoneFor(7, zones), "playin");
	assert.equal(core.zoneFor(10, zones), "playin");
	assert.equal(core.zoneFor(11, zones), null, "mid-table gets no colour");
	assert.equal(core.zoneFor(13, zones), null);
	assert.equal(core.zoneFor(14, zones), "relegation");
});

test("zoneFor returns null when zones are disabled", () => {
	assert.equal(core.zoneFor(1, null), null);
	assert.equal(core.zoneFor(14, undefined), null);
});

test("game sides carry a crest url when the feed has one", () => {
	const games = core.mapGames(todayGames);
	assert.equal(games[0].home.logo, null, "this fixture has no icon");
	const withIcon = core.mapGame({
		uuid: "x",
		startDateTime: "2026-11-24T18:00:00.000Z",
		state: "pre-game",
		homeTeamInfo: { code: "FBK", icon: "https://example.invalid/fbk.svg", names: { code: "FBK", short: "Färjestad" } },
		awayTeamInfo: { code: "LHF", names: { code: "LHF", short: "Luleå" } }
	});
	assert.equal(withIcon.home.logo, "https://example.invalid/fbk.svg");
	assert.equal(withIcon.away.logo, null);
});

/* -------------------------------------------------------------- events */

const PBP = [
	{ type: "shot", eventUuid: "s", period: 1, time: "16:17" },
	{ type: "penalty", eventUuid: "p", eventId: 33, revision: 2, period: 1, time: "12:29", eventTeam: { teamId: "OHK", teamCode: "ÖRE" }, player: { familyName: "Backström" }, variant: { description: "2 min" } },
	{ type: "goal", eventUuid: "g", eventId: 27, revision: 1, period: 1, time: "09:42", eventTeam: { teamCode: "ÖRE" }, player: { familyName: "Fel" }, homeGoals: 1, awayGoals: 0 },
	{ type: "goal", eventUuid: "g", eventId: 27, revision: 3, period: 1, time: "09:42", eventTeam: { teamCode: "ÖRE" }, player: { familyName: "Stockselius" }, homeGoals: 1, awayGoals: 0 },
	{ type: "goal", eventUuid: "h", eventId: 50, revision: 1, period: 2, time: "01:05", eventTeam: { teamCode: "FHC" }, player: { familyName: "Hasa" }, homeGoals: 1, awayGoals: 1 },
	{ type: "period", period: 1 }
];

test("events keep goals and penalties only, newest first, latest revision", () => {
	assert.deepStrictEqual(core.mapEvents(PBP), [
		{ type: "goal", period: 2, time: "01:05", team: "FHC", player: "Hasa", detail: "1–1" },
		{ type: "penalty", period: 1, time: "12:29", team: "ÖRE", player: "Backström", detail: "2 min" },
		{ type: "goal", period: 1, time: "09:42", team: "ÖRE", player: "Stockselius", detail: "1–0" }
	]);
	assert.strictEqual(core.mapEvents(PBP, 1).length, 1);
});

test("malformed events never throw", () => {
	for (const bad of [null, undefined, {}, "x", [null, {}, 3]]) assert.deepStrictEqual(core.mapEvents(bad), []);
	assert.deepStrictEqual(core.mapEvents([{ type: "penalty" }]), [
		{ type: "penalty", period: 0, time: "", team: "", player: "", detail: "" }
	]);
});
