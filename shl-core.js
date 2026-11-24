/* MMM-SHL-Tabell core — pure functions, no I/O.
 *
 * Loaded both by node_helper.js (via require) and by the browser (via
 * getScripts), so it must not touch the network, the filesystem or the DOM.
 *
 * Everything the mirror shows is Swedish; code and comments are English.
 */
"use strict";

(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.ShlCore = api;
})(typeof self !== "undefined" ? self : this, function () {
	const MINUTE = 60 * 1000;

	/* ----------------------------------------------------------- matching */

	/** Lower-case, trim, collapse whitespace. The API ships names like "Frölunda " with a trailing space. */
	function norm(value) {
		return String(value === undefined || value === null ? "" : value)
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	}

	/**
	 * Every string a human might reasonably put in config to mean this team.
	 *
	 * The API is not internally consistent: Örebro arrives as teamId "OHK" in
	 * the standings but names.code "ÖRE" in the game feeds, so both have to be
	 * accepted or the favourite silently never matches.
	 */
	function teamKeys(team) {
		if (!team) return [];
		const names = team.names || {};
		return [team.teamId, team.code, names.code, names.codeSite, names.short, names.shortSite, names.long, names.longSite]
			.map(norm)
			.filter((s) => s.length > 0);
	}

	/**
	 * Resolve the configured favourite against the teams actually in the league.
	 *
	 * Returns { teamId, team } on a match, { teamId: null } when no favourite is
	 * configured, and { teamId: null, unmatched: "<what they typed>" } when they
	 * configured something we cannot find — the caller warns and carries on.
	 */
	function resolveFavourite(teams, favoriteTeam) {
		const wanted = norm(favoriteTeam);
		if (!wanted) return { teamId: null, team: null };
		for (const team of teams || []) {
			if (teamKeys(team).includes(wanted)) return { teamId: team.teamId, team };
		}
		return { teamId: null, team: null, unmatched: String(favoriteTeam).trim() };
	}

	/* ---------------------------------------------------------- standings */

	/** Flatten one league-standings row into the handful of fields we render. */
	function mapStandingsRow(row) {
		const info = row.info || {};
		const teamInfo = info.teamInfo || {};
		const names = teamInfo.teamNames || {};
		return {
			rank: num(row.Rank),
			teamId: String(teamInfo.teamId || info.teamId || "").trim(),
			names: {
				code: String(names.code || "").trim(),
				codeSite: String(names.code_site || names.codeSite || "").trim(),
				short: String(names.short || info.code || "").trim(),
				shortSite: String(names.short_site || names.shortSite || "").trim(),
				long: String(names.long || "").trim()
			},
			display: String(names.short || info.code || teamInfo.teamId || "").trim(),
			logo: teamInfo.teamMedia || null,
			gp: num(row.GP),
			w: num(row.W),
			otw: num(row.OTW),
			otl: num(row.OTL),
			l: num(row.L),
			gf: num(row.G),
			ga: num(row.GA),
			diff: num(row.Diff),
			points: num(row.Points)
		};
	}

	function mapStandings(payload) {
		const rows = (payload && payload.leagueStandings) || [];
		if (!Array.isArray(rows)) return [];
		return rows.map(mapStandingsRow).sort((a, b) => a.rank - b.rank);
	}

	function num(value) {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	}

	/* -------------------------------------------------------------- games */

	function mapTeamSide(side) {
		const names = (side && side.names) || {};
		return {
			teamId: String((side && side.code) || "").trim(),
			code: String(names.code || (side && side.code) || "").trim(),
			names: {
				code: String(names.code || "").trim(),
				codeSite: String(names.codeSite || "").trim(),
				short: String(names.short || "").trim(),
				shortSite: String(names.shortSite || "").trim(),
				long: String(names.long || "").trim()
			},
			display: String(names.short || names.code || "").trim(),
			logo: (side && side.icon) || null,
			score: Number.isFinite(Number(side && side.score)) ? Number(side.score) : null
		};
	}

	/** One game from today-games / next-game-day / last-game-day. */
	function mapGame(game) {
		return {
			uuid: String(game.uuid || ""),
			start: game.startDateTime ? Date.parse(game.startDateTime) : null,
			state: String(game.state || "").replace(/_/g, "-").toLowerCase(),
			overtime: Boolean(game.overtime),
			shootout: Boolean(game.shootout),
			venue: (game.venueInfo && game.venueInfo.name) || "",
			home: mapTeamSide(game.homeTeamInfo),
			away: mapTeamSide(game.awayTeamInfo),
			live: false,
			period: null,
			clock: null
		};
	}

	function mapGames(payload) {
		const list = Array.isArray(payload) ? payload : (payload && payload.games) || [];
		return list.filter((g) => g && g.uuid).map(mapGame);
	}

	/**
	 * Pull period and clock out of gameday/game-overview's `time` object.
	 *
	 * That object is empty before puck drop and undocumented during play, so
	 * rather than assume a shape we look for any of the plausible keys and
	 * render nothing when none of them are there. A missing clock costs us a
	 * line of detail; a thrown TypeError costs the whole wall display.
	 */
	function readGameTime(time) {
		if (!time || typeof time !== "object") return { period: null, clock: null };
		const period = firstDefined(time, ["period", "periodNumber", "currentPeriod", "periodId"]);
		const clock = firstDefined(time, ["periodTime", "gameTime", "time", "displayTime", "clock"]);
		return {
			period: period === null ? null : String(period).trim() || null,
			clock: clock === null ? null : String(clock).trim() || null
		};
	}

	function firstDefined(obj, keys) {
		for (const key of keys) {
			const v = obj[key];
			if (v !== undefined && v !== null && v !== "") return v;
		}
		return null;
	}

	function isFinished(state) {
		return state === "post-game" || state === "postgame" || state === "finished" || state === "ended";
	}

	/**
	 * Decide which of today's games are actually being played right now.
	 *
	 * Deliberately not based on the API's `state` string alone: gameday reports
	 * "Ongoing" from roughly an hour before puck drop, and today-games still
	 * says "pre-game" at the same moment. So a game counts as live only when
	 * the league's own live list names it, the start time has passed, and it
	 * has not finished.
	 */
	function applyLive(games, liveUuids, overviews, now) {
		const live = new Set(liveUuids || []);
		const byUuid = overviews || {};
		const at = now || Date.now();

		for (const game of games) {
			const overview = byUuid[game.uuid] || null;
			if (overview) {
				if (Number.isFinite(Number(overview.homeGoals))) game.home.score = Number(overview.homeGoals);
				if (Number.isFinite(Number(overview.awayGoals))) game.away.score = Number(overview.awayGoals);
				const t = readGameTime(overview.time);
				game.period = t.period;
				game.clock = t.clock;
				if (isFinished(String(overview.state || "").replace(/_/g, "-").toLowerCase())) game.state = "post-game";
			}
			game.live = live.has(game.uuid) && game.start !== null && at >= game.start && !isFinished(game.state);
		}
		return games;
	}

	/** The favourite's game today, if there is one. */
	function findFavouriteGame(games, teamId) {
		if (!teamId) return null;
		const wanted = norm(teamId);
		return (
			games.find((g) => teamKeys(g.home).includes(wanted) || teamKeys(g.away).includes(wanted)) || null
		);
	}

	/**
	 * Which games, if any, belong in the panel above the table.
	 *
	 * "favorite" is the quiet default for a wall display: the panel appears
	 * when the favourite is playing and is absent the rest of the time, so the
	 * table normally sits alone. With no favourite configured it shows nothing
	 * rather than silently behaving like "all".
	 *
	 * Always returns an array; an empty one means render no panel at all —
	 * not an empty box, not a placeholder.
	 */
	function selectLiveGames(games, favouriteTeamId, mode) {
		const list = Array.isArray(games) ? games : [];
		if (mode === "off") return [];

		if (mode === "all") {
			const live = list.filter((g) => g.live);
			if (live.length > 0) return live;
			// Nothing in progress: show tonight's fixtures, but only before they start.
			return list.filter((g) => !isFinished(g.state));
		}

		// "favorite" (default)
		if (!favouriteTeamId) return [];
		const game = findFavouriteGame(list, favouriteTeamId);
		if (!game) return [];
		if (isFinished(game.state) && !game.live) return [game];
		return [game];
	}

	/* --------------------------------------------------------------- zones */

	/**
	 * Which qualification zone a rank sits in, or null for mid-table.
	 *
	 * This is the one place colour earns its keep on a mirror: it tells you
	 * something the numbers alone do not, at a glance, from the far side of
	 * the room. Everything else stays monochrome.
	 */
	function zoneFor(rank, zones) {
		if (!zones) return null;
		if (zones.playoff && rank <= zones.playoff) return "playoff";
		if (zones.playin && rank <= zones.playin) return "playin";
		if (zones.relegation && rank >= zones.relegation) return "relegation";
		return null;
	}

	/* ------------------------------------------------------------ polling */

	/**
	 * How long until the next fetch.
	 *
	 * Fast only while something is actually happening. An undocumented endpoint
	 * deserves a light touch, so the common case — no hockey today — is half an
	 * hour, and 60s applies only around live play.
	 */
	function nextPollDelay(games, opts, now) {
		const o = opts || {};
		const liveInterval = o.liveInterval || 60 * 1000;
		const idleInterval = o.idleInterval || 30 * MINUTE;
		const gamedayInterval = o.gamedayInterval || 10 * MINUTE;
		const preGameLead = o.preGameLead || 20 * MINUTE;
		const at = now || Date.now();

		if (games.some((g) => g.live)) return liveInterval;

		const upcoming = games
			.filter((g) => g.start !== null && g.start > at && !isFinished(g.state))
			.map((g) => g.start - at)
			.sort((a, b) => a - b)[0];

		if (upcoming !== undefined && upcoming <= preGameLead) return liveInterval;
		// A game that started but is not in the live list yet: check back shortly.
		if (games.some((g) => g.start !== null && g.start <= at && !isFinished(g.state))) return liveInterval;
		if (games.length > 0) return gamedayInterval;
		return idleInterval;
	}

	/* --------------------------------------------------------- formatting */

	function formatTime(ms, timeZone) {
		if (!ms) return "";
		try {
			return new Intl.DateTimeFormat("sv-SE", {
				hour: "2-digit",
				minute: "2-digit",
				timeZone: timeZone || "Europe/Stockholm"
			}).format(new Date(ms));
		} catch {
			return "";
		}
	}

	function formatDateTime(ms, timeZone) {
		if (!ms) return "";
		try {
			return new Intl.DateTimeFormat("sv-SE", {
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
				timeZone: timeZone || "Europe/Stockholm"
			}).format(new Date(ms));
		} catch {
			return "";
		}
	}

	function formatDiff(diff) {
		return diff > 0 ? `+${diff}` : String(diff);
	}

	/** "P2 12:34", "P2", "LIVE" — whatever the feed actually gave us. */
	function liveLabel(game) {
		const bits = [];
		if (game.period) bits.push(/^\d+$/.test(game.period) ? `P${game.period}` : game.period);
		if (game.clock) bits.push(game.clock);
		if (bits.length === 0) return "LIVE";
		return bits.join(" ");
	}

	return {
		norm,
		teamKeys,
		resolveFavourite,
		mapStandings,
		mapStandingsRow,
		mapGames,
		mapGame,
		applyLive,
		readGameTime,
		isFinished,
		findFavouriteGame,
		selectLiveGames,
		zoneFor,
		nextPollDelay,
		formatTime,
		formatDateTime,
		formatDiff,
		liveLabel
	};
});
