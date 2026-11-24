/* MMM-SHL-Tabell node helper — owns all network and disk access.
 *
 * One shared poller regardless of how many module instances subscribe. The
 * poll rate adapts: half-hourly when there is no hockey, every minute only
 * while a game is actually being played.
 */
"use strict";

const NodeHelper = require("node_helper");
const path = require("node:path");
let Log;
try {
	Log = require("logger"); // MagicMirror >= 2.14
} catch {
	Log = console;
}

const api = require("./lib/api.js");
const core = require("./shl-core.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SSGT_TTL = 12 * HOUR;
const COLD_START_RETRY = 2 * MINUTE;
const STANDINGS_MIN_AGE = 5 * MINUTE;

module.exports = NodeHelper.create({
	start() {
		this.timer = null;
		this.started = false;
		this.config = null;
		this.ssgt = null;
		this.ssgtAt = 0;
		this.standingsAt = 0;
		this.state = null;
	},

	cacheFile(name) {
		return path.join(__dirname, "cache", `${name}.json`);
	},

	async socketNotificationReceived(notification, payload) {
		if (notification !== "SHL_SUBSCRIBE") return;

		// First subscriber wins the config; later ones just get the data.
		if (!this.config) this.config = payload || {};

		if (!this.state) this.state = await api.readCache(this.cacheFile("state"));
		if (this.state) this.sendSocketNotification("SHL_DATA", this.state);

		if (!this.started) {
			this.started = true;
			this.run();
		}
	},

	schedule(delay) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.run(), Math.max(5000, delay));
	},

	async run() {
		this.timer = null;
		let delay = this.config.idleInterval || 30 * MINUTE;

		try {
			const ssgt = await this.currentSsgt();
			const games = await this.loadGames(ssgt.uuid);
			const standings = await this.loadStandings(ssgt.uuid);
			await this.loadEvents(games, standings);

			this.state = {
				ok: true,
				fetchedAt: Date.now(),
				season: ssgt,
				standings,
				games,
				error: null
			};
			await api.writeCache(this.cacheFile("state"), this.state);

			const liveCount = games.filter((g) => g.live).length;
			Log.info(
				`[MMM-SHL-Tabell] ${standings.length} lag i tabellen, ${games.length} matcher idag` +
					(liveCount ? `, ${liveCount} live` : "")
			);
			delay = core.nextPollDelay(games, this.config, Date.now());
		} catch (err) {
			const message = (err && err.message) || String(err);
			if (this.state) {
				// Keep serving the last good table, flagged as stale.
				this.state = { ...this.state, ok: false, error: { message }, erroredAt: Date.now() };
				Log.warn(`[MMM-SHL-Tabell] hämtning misslyckades (${message}); visar sparad tabell`);
				delay = this.config.idleInterval || 30 * MINUTE;
			} else {
				this.state = { ok: false, fetchedAt: null, season: null, standings: [], games: [], error: { message } };
				Log.error(`[MMM-SHL-Tabell] hämtning misslyckades utan cache (${message})`);
				delay = COLD_START_RETRY;
			}
		}

		this.sendSocketNotification("SHL_DATA", this.state);
		this.schedule(delay);
	},

	/**
	 * The current season, re-resolved at most twice a day.
	 *
	 * If the lookup fails but we already know which season we are in — from
	 * this process or from the cache on disk — we carry on with that rather
	 * than throwing away an otherwise fine refresh. The season changes once a
	 * year; a blip in one request is not a reason to lose tonight's table.
	 * It is deliberately not stamped as fresh, so the next poll tries again.
	 */
	async currentSsgt() {
		if (this.ssgt && Date.now() - this.ssgtAt < SSGT_TTL) return this.ssgt;
		const seriesUuid = this.config.seriesUuid || "qQ9-bb0bzEWUk";
		try {
			this.ssgt = await api.fetchSsgt(seriesUuid);
			this.ssgtAt = Date.now();
			Log.info(`[MMM-SHL-Tabell] säsong: ${this.ssgt.label || this.ssgt.seasonCode} (${this.ssgt.uuid})`);
			return this.ssgt;
		} catch (err) {
			const known = this.ssgt || (this.state && this.state.season);
			if (!known || !known.uuid) throw err;
			Log.warn(
				`[MMM-SHL-Tabell] latest-ssgt svarade inte (${(err && err.message) || err}); ` +
					`fortsätter med känd säsong ${known.label || known.uuid}`
			);
			this.ssgt = known;
			this.ssgtAt = 0;
			return known;
		}
	},

	/**
	 * The standings move only when a game ends, so there is no point pulling
	 * them on every 60-second live tick.
	 */
	async loadStandings(ssgtUuid) {
		const fresh = Date.now() - this.standingsAt < STANDINGS_MIN_AGE;
		if (fresh && this.state && this.state.standings && this.state.standings.length) return this.state.standings;

		const standings = core.mapStandings(await api.fetchStandings(ssgtUuid));
		if (standings.length === 0 && this.state && this.state.standings && this.state.standings.length) {
			// Off-season or a bad response: an empty table is worse than yesterday's.
			Log.warn("[MMM-SHL-Tabell] tom tabell från API:t; behåller den sparade");
			return this.state.standings;
		}
		await this.cacheLogos(standings);
		this.standingsAt = Date.now();
		return standings;
	},

	/**
	 * Mirror each team's crest into cache/logos/ and point the row at the
	 * local copy. Falls back to the CDN URL for any that would not download,
	 * so a missing logo costs a crest, not a row.
	 */
	async cacheLogos(standings) {
		for (const team of standings) {
			if (!team.logo || !team.teamId) continue;
			const name = `${team.teamId.replace(/[^A-Za-z0-9]/g, "")}.svg`;
			const file = path.join(__dirname, "cache", "logos", name);
			const ok = await api.cacheLogo(team.logo, file);
			team.logoSrc = ok ? `modules/MMM-SHL-Tabell/cache/logos/${name}` : team.logo;
		}
	},

	/**
	 * Today's games, enriched with live score and clock.
	 *
	 * If there is no hockey today we fall back to the next game day so the
	 * module can say when the favourite plays next instead of showing nothing.
	 */
	async loadGames(ssgtUuid) {
		let games = core.mapGames(await api.fetchTodayGames(ssgtUuid));
		let upcoming = false;

		if (games.length === 0) {
			try {
				games = core.mapGames(await api.fetchNextGameDay(ssgtUuid));
				upcoming = true;
			} catch {
				games = [];
			}
		}
		for (const g of games) g.upcomingDay = upcoming;
		if (games.length === 0) return games;

		let liveUuids = [];
		try {
			liveUuids = await api.fetchLiveUuids();
		} catch (err) {
			Log.warn(`[MMM-SHL-Tabell] live-listan svarade inte (${(err && err.message) || err})`);
		}

		// Only ask for detail on games the league itself says are live.
		const wanted = games.filter((g) => liveUuids.includes(g.uuid)).map((g) => g.uuid);
		const overviews = {};
		for (const uuid of wanted) {
			try {
				const overview = await api.fetchGameOverview(uuid);
				if (overview) overviews[uuid] = overview;
			} catch (err) {
				Log.warn(`[MMM-SHL-Tabell] game-overview ${uuid} svarade inte (${(err && err.message) || err})`);
			}
		}

		return core.applyLive(games, liveUuids, overviews, Date.now());
	},

	/**
	 * Latest goals and penalties for the favourite's game, while it is live.
	 *
	 * Purely decorative: a failure keeps the events we already had for that
	 * game and never costs the score or the table.
	 */
	async loadEvents(games, standings) {
		const favourite = core.resolveFavourite(standings, this.config.eventsFor).teamId;
		const game = core.findFavouriteGame(games, favourite);
		if (!game || !game.live) return;
		try {
			game.events = core.mapEvents(await api.fetchPlayByPlay(game.uuid));
		} catch (err) {
			Log.warn(`[MMM-SHL-Tabell] play-by-play svarade inte (${(err && err.message) || err})`);
			const before = ((this.state && this.state.games) || []).find((g) => g.uuid === game.uuid);
			game.events = (before && before.events) || [];
		}
	},

	stop() {
		clearTimeout(this.timer);
		this.timer = null;
	}
});
