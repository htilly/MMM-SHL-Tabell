/* Network and disk for MMM-SHL-Tabell.
 *
 * Talks to shl.se's own site API — the one their gameday widget uses. It is
 * undocumented and unversioned, so every call is defensive and every success
 * is written to disk: a wall display should show a stale table, never a blank
 * one or a stack trace.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const BASE = "https://www.shl.se/api";
const INSTANCE_ID = "shl1_shl";
const TIMEOUT = 10000;

const HEADERS = {
	Accept: "application/json",
	"x-s8y-instance-id": INSTANCE_ID,
	"User-Agent": "MMM-SHL-Tabell (MagicMirror module)"
};

async function getJson(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT);
	try {
		const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status} for ${url}`);
			err.status = res.status;
			throw err;
		}
		const text = await res.text();
		if (!text.trim()) return null;
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve the current season/series/game-type.
 *
 * The ssgtUuid changes every season, which is exactly why this is a runtime
 * lookup and not a constant in config.
 */
async function fetchSsgt(seriesUuid) {
	const data = await getJson(`${BASE}/sports-v2/latest-ssgt/${encodeURIComponent(seriesUuid)}`);
	if (!data || !data.uuid) throw new Error("latest-ssgt returned no uuid");
	const names = Array.isArray(data.names) ? data.names : [];
	const sv = names.find((n) => n && n.language === "sv");
	return {
		uuid: data.uuid,
		seasonCode: (data.season && data.season.code) || "",
		seriesCode: (data.series && data.series.code) || "",
		label: (sv && sv.translation) || ""
	};
}

function fetchStandings(ssgtUuid) {
	return getJson(`${BASE}/statistics-v2/league-standings?ssgtUuid=${encodeURIComponent(ssgtUuid)}`);
}

function fetchTodayGames(ssgtUuid) {
	return getJson(`${BASE}/sports-v2/today-games?seasonSeriesGameType=${encodeURIComponent(ssgtUuid)}`);
}

function fetchNextGameDay(ssgtUuid) {
	return getJson(`${BASE}/sports-v2/next-game-day?seasonSeriesGameType=${encodeURIComponent(ssgtUuid)}`);
}

/** 93 bytes of gameUuids. Cheap enough to poll at 60s while hockey is on. */
async function fetchLiveUuids() {
	const data = await getJson(`${BASE}/sports-v2/upcoming-live-games`);
	if (!Array.isArray(data)) return [];
	return data.map((g) => g && g.gameUuid).filter(Boolean);
}

function fetchGameOverview(gameUuid) {
	return getJson(`${BASE}/gameday/game-overview/${encodeURIComponent(gameUuid)}`);
}

/* ------------------------------------------------------------------ logos */

/**
 * Fetch a team logo once and keep it on disk.
 *
 * Logos change about never, so pulling 14 SVGs from a CDN every time the
 * mirror re-renders would be rude and pointless. Caching them locally also
 * means the table still has its crests when shl.se is unreachable.
 *
 * Returns true if the file is on disk afterwards, false if we could not get it.
 */
async function cacheLogo(url, destFile) {
	try {
		await fs.access(destFile);
		return true; // already have it
	} catch {
		// not cached yet; fall through and fetch
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT);
	try {
		const res = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"] }, signal: controller.signal });
		if (!res.ok) return false;
		const body = await res.text();
		// A logo that is not SVG is not something we want to write blindly.
		if (!/<svg[\s>]/i.test(body)) return false;
		await fs.mkdir(path.dirname(destFile), { recursive: true });
		await fs.writeFile(destFile, body, "utf8");
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------ cache */

async function readCache(file) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function writeCache(file, data) {
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(data), "utf8");
	} catch {
		// A read-only or full disk must not take the module down; we still have
		// the data in memory for as long as the process lives.
	}
}

module.exports = {
	BASE,
	fetchSsgt,
	fetchStandings,
	fetchTodayGames,
	fetchNextGameDay,
	fetchLiveUuids,
	fetchGameOverview,
	cacheLogo,
	readCache,
	writeCache
};
