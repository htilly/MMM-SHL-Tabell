/* MMM-SHL-Tabell — the SHL standings table, with live scores.
 *
 * The table is the point and is always there. The live panel is a guest: it
 * appears when there is hockey worth looking at and is completely absent the
 * rest of the time, so the normal state of this module is a table alone.
 *
 * Data: https://www.shl.se/api (the site's own feed), fetched by node_helper.js.
 * Everything shown on the mirror is Swedish; code and comments are English.
 */
/* global Module, ShlCore, Log */

Module.register("MMM-SHL-Tabell", {
	defaults: {
		header: "SHL",
		// Team code ("FBK") or short name ("Färjestad"), case-insensitive.
		// Empty string = no favourite: plain table, no highlight, no live panel.
		favoriteTeam: "FBK",
		// "favorite" — panel only when the favourite plays (quiet default)
		// "all"      — every game in progress
		// "off"      — standings only
		liveGames: "favorite",
		maxRows: 14,
		// Draw a rule after these ranks: playoffs, play-in, play-out.
		dividers: [6, 10, 13],
		// Colour the rank numbers by qualification zone, for example
		// { playoff: 6, playin: 10, relegation: 14 }. null = uncoloured.
		zones: null,
		// true  — every column (M, V, ÖTV, ÖTF, F, MÅL, +/-, P)
		// false — just +/- and P
		showAllStats: false,
		showLogos: true,
		showUpdated: true,
		// Flag the table as stale once this long has passed with no fresh data,
		// whether or not an error was recorded.
		staleWarningMinutes: 90,
		// Re-subscribe if the node helper has said nothing for this long.
		resubscribeAfter: 90 * 60 * 1000,
		liveInterval: 60 * 1000,
		gamedayInterval: 10 * 60 * 1000,
		idleInterval: 30 * 60 * 1000,
		preGameLead: 20 * 60 * 1000,
		seriesUuid: "qQ9-bb0bzEWUk",
		timeZone: "Europe/Stockholm"
	},

	getScripts() {
		return [this.file("shl-core.js")];
	},

	getStyles() {
		return [this.file("MMM-SHL-Tabell.css")];
	},

	getHeader() {
		return this.config.header || this.data.header || "";
	},

	start() {
		this.payload = null;
		this.hasRendered = false;
		this.warnedUnmatched = false;
		this.suspended = false;
		this.heardAt = 0;
		this.subscribedAt = 0;

		this.subscribe();

		// Re-render each minute so the "senast uppdaterad" stamp and the
		// staleness warning stay honest between fetches, and take the chance
		// to notice if the helper has stopped answering.
		setInterval(() => {
			this.resubscribeIfStarved();
			if (this.payload && !this.suspended) this.updateDom();
		}, 60 * 1000);
	},

	subscribe() {
		this.subscribedAt = Date.now();
		this.sendSocketNotification("SHL_SUBSCRIBE", {
			seriesUuid: this.config.seriesUuid,
			liveInterval: this.config.liveInterval,
			gamedayInterval: this.config.gamedayInterval,
			idleInterval: this.config.idleInterval,
			preGameLead: this.config.preGameLead
		});
	},

	/**
	 * Re-subscribe if the helper has gone quiet.
	 *
	 * The trap this exists for: MagicMirror's server restarts, socket.io
	 * reconnects underneath us, but start() never runs again — so the new
	 * helper process is sitting there having never received a subscribe, and
	 * the mirror shows a table that quietly ages forever.
	 *
	 * Silence is the signal, not stale data: a helper that is still reporting
	 * failures is alive and re-subscribing would achieve nothing. A subscribe
	 * we only just sent is given time to be answered.
	 */
	resubscribeIfStarved() {
		const after = this.config.resubscribeAfter;
		if (!after) return;
		const now = Date.now();
		if (now - (this.heardAt || 0) < after) return;
		if (now - (this.subscribedAt || 0) < after) return;
		Log.warn("[MMM-SHL-Tabell] inget svar från node_helper på länge – prenumererar om.");
		this.subscribe();
	},

	socketNotificationReceived(notification, payload) {
		if (notification !== "SHL_DATA") return;
		this.heardAt = Date.now();
		this.payload = payload;
		if (this.suspended) return;
		this.updateDom(this.hasRendered ? 1000 : 0);
		this.hasRendered = true;
	},

	/* MMM-pages hides this module for half of every rotation; there is no
	   point redrawing a table nobody can see. */
	suspend() {
		this.suspended = true;
	},

	resume() {
		this.suspended = false;
		// Redraw on the way back so the timestamp is not a minute stale.
		this.updateDom();
	},

	/* ------------------------------------------------------------- helpers */

	el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	},

	cell(row, className, text) {
		const td = this.el("td", className, text);
		row.appendChild(td);
		return td;
	},

	/**
	 * Resolve the configured favourite against the teams in the table.
	 *
	 * A typo in config costs a highlight, never a render: we warn once to the
	 * log and carry on with a plain table.
	 */
	favourite() {
		const p = this.payload;
		if (!p || !p.standings || p.standings.length === 0) return null;
		const resolved = ShlCore.resolveFavourite(p.standings, this.config.favoriteTeam);
		if (resolved.unmatched && !this.warnedUnmatched) {
			this.warnedUnmatched = true;
			Log.warn(
				`[MMM-SHL-Tabell] favoriteTeam "${resolved.unmatched}" matchar inget lag i SHL den här säsongen. ` +
					`Giltiga koder: ${p.standings.map((t) => t.teamId).join(", ")}. Visar tabellen utan markering.`
			);
		}
		return resolved.teamId;
	},

	/* -------------------------------------------------------------- render */

	getDom() {
		const root = this.el("div", "shl");
		const p = this.payload;

		if (!p) {
			root.appendChild(this.el("div", "shl-message dimmed small", "Hämtar SHL-tabellen…"));
			return root;
		}

		if (!p.standings || p.standings.length === 0) {
			root.appendChild(this.el("div", "shl-message small dimmed", "Ingen SHL-tabell tillgänglig just nu."));
			if (p.error) root.appendChild(this.el("div", "shl-message xsmall dimmed", "Försöker igen om en stund."));
			return root;
		}

		const favourite = this.favourite();

		const panel = this.renderLivePanel(favourite);
		if (panel) root.appendChild(panel);

		root.appendChild(this.renderTable(favourite));

		const note = this.footNote();
		if (note) root.appendChild(this.el("div", `shl-foot xsmall ${note.stale ? "shl-foot--stale" : "dimmed"}`, note.text));

		return root;
	},

	/**
	 * The live panel, or null.
	 *
	 * Returning null rather than an empty element matters: on most evenings
	 * there is no hockey, and the table should sit alone with no gap above it.
	 */
	renderLivePanel(favourite) {
		const games = ShlCore.selectLiveGames(this.payload.games || [], favourite, this.config.liveGames);
		if (games.length === 0) return null;

		const box = this.el("div", "shl-live");
		const isFavouriteMode = this.config.liveGames !== "all";

		for (const game of games) {
			box.appendChild(isFavouriteMode ? this.renderHeroGame(game, favourite) : this.renderGameRow(game, favourite));
		}
		return box;
	},

	/**
	 * The favourite's game, sized to be read from across the room.
	 *
	 * Live: a pulsing LIVE tag, the score as the hero, period and clock under
	 * it. Not started: the fixture and the time. Finished: the final score,
	 * quietly.
	 */
	renderHeroGame(game, favourite) {
		const live = game.live;
		const finished = ShlCore.isFinished(game.state) && !live;
		const card = this.el("div", `shl-hero${live ? " shl-hero--live" : ""}${finished ? " shl-hero--done" : ""}`);

		const tag = this.el("div", "shl-hero-tag");
		if (live) {
			tag.appendChild(this.el("span", "shl-dot"));
			tag.appendChild(this.el("span", "shl-hero-tag-text", ShlCore.liveLabel(game)));
		} else if (finished) {
			tag.appendChild(this.el("span", "shl-hero-tag-text dimmed", this.finalLabel(game)));
		} else {
			tag.appendChild(this.el("span", "shl-hero-tag-text dimmed", this.kickoffLabel(game)));
		}
		card.appendChild(tag);

		const score = this.el("div", "shl-hero-score");
		score.appendChild(this.heroSide(game.home, favourite, "home"));
		score.appendChild(
			this.el("span", "shl-hero-nums", live || finished ? `${game.home.score ?? 0} – ${game.away.score ?? 0}` : "–")
		);
		score.appendChild(this.heroSide(game.away, favourite, "away"));
		card.appendChild(score);

		if (game.venue && !finished) card.appendChild(this.el("div", "shl-hero-venue xsmall dimmed", game.venue));
		return card;
	},

	/** One line per game, for liveGames: "all". */
	renderGameRow(game, favourite) {
		const live = game.live;
		const finished = ShlCore.isFinished(game.state) && !live;
		const row = this.el("div", `shl-game${live ? " shl-game--live" : ""}`);

		const status = this.el("span", "shl-game-status xsmall");
		if (live) {
			status.appendChild(this.el("span", "shl-dot"));
			status.appendChild(this.el("span", null, ShlCore.liveLabel(game)));
		} else {
			status.className += " dimmed";
			status.textContent = finished ? this.finalLabel(game) : ShlCore.formatTime(game.start, this.config.timeZone);
		}
		row.appendChild(status);

		row.appendChild(this.teamName(game.home, favourite, "shl-game-team shl-game-team--home"));
		row.appendChild(
			this.el(
				"span",
				`shl-game-score${live || finished ? " bright" : " dimmed"}`,
				live || finished ? `${game.home.score ?? 0}–${game.away.score ?? 0}` : "–"
			)
		);
		row.appendChild(this.teamName(game.away, favourite, "shl-game-team shl-game-team--away"));
		return row;
	},

	/** Crest above name, mirrored left/right so the score sits between them. */
	heroSide(side, favourite, which) {
		const isFav = favourite ? ShlCore.teamKeys(side).includes(ShlCore.norm(favourite)) : false;
		const box = this.el("div", `shl-hero-side shl-hero-side--${which}${isFav ? " shl-fav-text" : ""}`);
		if (this.config.showLogos && side.logo) box.appendChild(this.logo(side.logo, "shl-logo--hero"));
		box.appendChild(this.el("span", "shl-hero-team", side.display || side.code));
		return box;
	},

	teamName(side, favourite, className) {
		const isFav = favourite ? ShlCore.teamKeys(side).includes(ShlCore.norm(favourite)) : false;
		return this.el("span", `${className || "shl-hero-team"}${isFav ? " shl-fav-text" : ""}`, side.display || side.code);
	},

	kickoffLabel(game) {
		const time = ShlCore.formatTime(game.start, this.config.timeZone);
		if (!time) return "Kommande";
		if (game.upcomingDay) return ShlCore.formatDateTime(game.start, this.config.timeZone);
		return `Ikväll ${time}`;
	},

	finalLabel(game) {
		if (game.shootout) return "Slutresultat efter straffar";
		if (game.overtime) return "Slutresultat efter förlängning";
		return "Slutresultat";
	},

	/* --------------------------------------------------------------- table */

	renderTable(favourite) {
		const rows = (this.payload.standings || []).slice(0, this.config.maxRows);
		const dividers = new Set(this.config.dividers || []);
		const allStats = this.config.showAllStats;
		const table = this.el("table", "shl-table small");

		const head = this.el("tr", "shl-head dimmed xsmall");
		const headings = [
			["", "shl-col-rank"],
			["Lag", "shl-col-team"],
			...(allStats
				? [
						["M", "shl-col-num"],
						["V", "shl-col-num"],
						["ÖTV", "shl-col-num"],
						["ÖTF", "shl-col-num"],
						["F", "shl-col-num"],
						["MÅL", "shl-col-goals"]
					]
				: []),
			["+/-", "shl-col-num"],
			["P", "shl-col-points"]
		];
		for (const [text, cls] of headings) head.appendChild(this.el("th", cls, text));
		table.appendChild(head);

		for (const team of rows) {
			const isFav = favourite && team.teamId === favourite;
			const zone = ShlCore.zoneFor(team.rank, this.config.zones);
			const classes = [
				"shl-row",
				isFav ? "shl-row--fav" : "",
				dividers.has(team.rank) ? "shl-row--divide" : "",
				zone ? `shl-row--${zone}` : ""
			]
				.filter(Boolean)
				.join(" ");
			const tr = this.el("tr", classes);

			// Uncoloured unless zones is set; then it carries the zone colour.
			this.cell(tr, "shl-col-rank", String(team.rank));

			const teamCell = this.cell(tr, "shl-col-team");
			if (this.config.showLogos && (team.logoSrc || team.logo)) {
				teamCell.appendChild(this.logo(team.logoSrc || team.logo));
			}
			teamCell.appendChild(this.el("span", `shl-team-name${isFav ? " bright" : ""}`, team.display));

			if (allStats) {
				this.cell(tr, "shl-col-num", String(team.gp));
				this.cell(tr, "shl-col-num", String(team.w));
				this.cell(tr, "shl-col-num", String(team.otw));
				this.cell(tr, "shl-col-num", String(team.otl));
				this.cell(tr, "shl-col-num", String(team.l));
				this.cell(tr, "shl-col-goals dimmed", `${team.gf}–${team.ga}`);
			}

			const diffClass = team.diff > 0 ? " shl-diff--up" : team.diff < 0 ? " shl-diff--down" : " dimmed";
			this.cell(tr, `shl-col-num${diffClass}`, ShlCore.formatDiff(team.diff));

			this.cell(tr, "shl-col-points", String(team.points));

			table.appendChild(tr);
		}
		return table;
	},

	/**
	 * A crest, on a black disc (see --shl-disc in the stylesheet).
	 *
	 * The fixed-size disc keeps the left edge of the table visually even.
	 */
	logo(src, extraClass) {
		const wrap = this.el("span", `shl-logo${extraClass ? ` ${extraClass}` : ""}`);
		const img = document.createElement("img");
		img.src = src;
		img.alt = "";
		img.loading = "lazy";
		// A crest that will not load should leave no gap and no broken icon.
		img.onerror = () => wrap.classList.add("shl-logo--missing");
		wrap.appendChild(img);
		return wrap;
	},

	/**
	 * "Senast uppdaterad 18:42" — and a visible warning once the data is old
	 * enough that someone might act on a wrong number.
	 */
	footNote() {
		const p = this.payload;
		if (!this.config.showUpdated || !p || !p.fetchedAt) return null;

		const ageMinutes = (Date.now() - p.fetchedAt) / 60000;
		// Past a day, a bare "från 17:13" reads as today. Show the date.
		const when =
			ageMinutes >= 24 * 60
				? ShlCore.formatDateTime(p.fetchedAt, this.config.timeZone)
				: ShlCore.formatTime(p.fetchedAt, this.config.timeZone);

		if (ageMinutes < this.config.staleWarningMinutes) {
			return { stale: false, text: `Senast uppdaterad ${when}` };
		}
		// Age alone decides staleness. A helper that dies quietly never records
		// an error, and that is exactly the case the wall must not hide.
		if (p.error) return { stale: true, text: `⚠️ Når inte shl.se – tabellen är från ${when}.` };
		return { stale: true, text: `⚠️ Ingen ny data sedan ${when}.` };
	}
});
