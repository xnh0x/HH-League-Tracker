// ==UserScript==
// @name         HH League Tracker
// @version      1.9.2
// @description  Highlight stat changes, track lost points
// @author       xnh0x
// @match        https://*.hentaiheroes.com/leagues.html*
// @match        https://*.hentaiheroes.com/home.html*
// @match        https://nutaku.haremheroes.com/leagues.html*
// @match        https://nutaku.haremheroes.com/home.html*
// @match        https://*.comixharem.com/leagues.html*
// @match        https://*.comixharem.com/home.html*
// @match        https://*.pornstarharem.com/leagues.html*
// @match        https://*.pornstarharem.com/home.html*
// @match        https://*.gayharem.com/leagues.html*
// @match        https://*.gayharem.com/home.html*
// @match        https://*.gaypornstarharem.com/leagues.html*
// @match        https://*.gaypornstarharem.com/home.html*
// @match        https://*.transpornstarharem.com/leagues.html*
// @match        https://*.transpornstarharem.com/home.html*
// @match        https://*.hornyheroes.com/leagues.html*
// @match        https://*.hornyheroes.com/home.html*
// @run-at       document-body
// @namespace    https://github.com/xnh0x/HH-League-Tracker
// @updateURL    https://github.com/xnh0x/HH-League-Tracker/raw/refs/heads/master/HHLeagueTracker.user.js
// @downloadURL  https://github.com/xnh0x/HH-League-Tracker/raw/refs/heads/master/HHLeagueTracker.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hentaiheroes.com
// @grant        unsafeWindow
// @grant        GM_info
// ==/UserScript==

(async function (window) {
    'use strict';
    /*global shared,opponents_list,$*/

    info('version:', GM_info.script.version)

    const CONFIG = await loadConfig();

    info('config:', CONFIG);

    if(window.location.pathname !== '/leagues.html') {
        return;
    }

    addCSS();

    const FORMAT = getFormatters();
    let GITHUB_PARAMS = {};

    const LOCAL_STORAGE_KEYS = {
        data: 'HHLeagueTrackerData',
        stats: 'HHLeagueTrackerStatData',
        leagueEnd: 'HHLeagueTrackerLeagueEnd'
    }

    const MY_ID = shared.Hero.infos.id;
    const PAGE_LOAD_TS = window.server_now_ts * 1000
    const LEAGUE_END_TS = (window.server_now_ts + window.season_end_at) * 1000;

    if (!opponents_list.length) {
        info('no opponents found');
        return;
    }

    const LEAGUE_ENDING = window.season_end_at < 10 * 60;
    const TOTAL_FIGHTS = (opponents_list.length - 1) * 3;
    const MAX_SCORE = TOTAL_FIGHTS * 25;

    const OPPONENT_DETAILS_BY_ID = opponents_list.reduce((map, object) => {
        object.HHLT = {}; // temporary storage for table modification
        map[object.player.id_fighter] = object;
        return map;
    }, {})
    const FIGHTS_DONE = opponents_list.reduce((total, object) => {
        if (object.player.id_fighter !== MY_ID) { total += Object.values(object.match_history)[0].reduce((c,m) => {return m ? c+1 : c;}, 0); }
        return total; }, 0);
    const MY_LOST_POINTS = FIGHTS_DONE * 25 - OPPONENT_DETAILS_BY_ID[MY_ID].player_league_points;

    if (CONFIG.githubStorage.enabled) {
        if (!window.LeagueTrackerGitHubConfig) {
            info('GitHubConfig missing, using localStorage')
            CONFIG.githubStorage.enabled = false;
        } else {
            GITHUB_PARAMS = window.LeagueTrackerGitHubConfig;
            const PLATFORM = shared.Hero.infos.hh_universe;
            // week and minimum id of all players uniquely identify a league bracket
            const LEAGUE_ID = opponents_list.reduce((a,b) => a.player.id_fighter < b.player.id_fighter ? a : b).player.id_fighter;
            const WEEK = getWeekName(LEAGUE_END_TS);
            GITHUB_PARAMS.path = `${PLATFORM}/${WEEK}/${LEAGUE_ID}_scores.json`;
            GITHUB_PARAMS.url = `https://api.github.com/repos/${GITHUB_PARAMS.owner}/${GITHUB_PARAMS.repo}/contents/${GITHUB_PARAMS.path}`;
        }
    }

    // check if a new league started and reset local storage and
    const STORED_LEAGUE_END_TS = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.leagueEnd)) || Infinity;
    localStorage.setItem(LOCAL_STORAGE_KEYS.leagueEnd, JSON.stringify(LEAGUE_END_TS));
    if (STORED_LEAGUE_END_TS < LEAGUE_END_TS) {
        info('new league has started, deleting old data from local storage')
        localStorage.removeItem(LOCAL_STORAGE_KEYS.data);
        localStorage.removeItem(LOCAL_STORAGE_KEYS.stats);
        if (CONFIG.githubStorage.enabled) {
            await commitNewFile();
            // give GitHub a moment to process the new file
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    GITHUB_PARAMS.needsUpdate = false;
    const observer = new MutationObserver(async () => {
        if (document.querySelectorAll('#leagues .league_table').length) {
            observer.disconnect();
            await leagueTracker(true);
        }
    })
    observer.observe(document.querySelector('#leagues'), {childList: true, subtree: true});

    async function leagueTracker(firstRun) {
        let localStorageData = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.data)) || {};
        let opponentStats = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.stats)) || {};

        let opponentData = {};
        if (CONFIG.githubStorage.enabled) {
            try {
                const {data, sha} = await mergeLocalAndGithubData(localStorageData);
                opponentData = data;
                GITHUB_PARAMS.sha = sha;
            } catch (status) {
                if (firstRun && status === 404) {
                    info(`${GITHUB_PARAMS.path} doesn't exist yet`)
                    try {
                        await commitNewFile();
                    } catch (f) {
                        info(f);
                    }
                    info('restart script');
                    setTimeout(leagueTracker, 500, false);
                    return;
                } else if (status === 401) {
                    info('check github config, token not valid for repo, using localStorage')
                } else {
                    info('couldn\'t read data from github, using localStorage');
                }
                CONFIG.githubStorage.enabled = false;
            }
        }

        // use local data in case the read from GitHub failed
        if (!Object.keys(opponentData).length) { opponentData = localStorageData; }

        // add nickname to make browsing the json a little more convenient
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                if (!opponentData[id]) { opponentData[id] = {}; }
                opponentData[id].nickname = encodeURI(OPPONENT_DETAILS_BY_ID[id].nickname);
            }
        );

        if (CONFIG.boosterTimer.enabled) {
            createBoosterCountdown();
        }

        calculateChanges(opponentData, opponentStats);
        writeTable();

        // redo changes after sorting the table
        const sortingObserver = new MutationObserver(() => { writeTable(); })
        sortingObserver.observe(document.querySelector('.league_table .data-list'), {childList: true})

        localStorage.setItem(LOCAL_STORAGE_KEYS.data, JSON.stringify(opponentData));
        localStorage.setItem(LOCAL_STORAGE_KEYS.stats, JSON.stringify(opponentStats));
        if (CONFIG.githubStorage.enabled) {
            if (GITHUB_PARAMS.needsUpdate) {
                await commitUpdate(opponentData);
            } else {
                info('nothing changed, no need to update');
            }
        }
    }

    function info() {
        log(arguments);
    }

    function log(args, tag = null) {
        let _args = ['League Tracker:'];
        if (tag) { _args.push(tag); }
        for( let i = 0; i < args.length; i++ ) {
            _args.push( args[i] );
        }
        console.log.apply( console, _args );
    }

    function addCSS() {
        let sheet = document.createElement("style");
        sheet.textContent = [
            // remove white blob below challenge results
            '.result { box-shadow: none !important; }',
            // shadow to improve readability in some games
            '.data-column:not(.head-column) { text-shadow: 1px 1px 0px #000 !important; }',
            // resize rank so the name header doesn't overlap
            '.data-row.head-row .head-column[column="place"] { width: 8rem !important; }',
            // outline for level on avatar
            CONFIG.hideLevel.move ? '.data-column[column="nickname"] .square-avatar-wrapper { text-shadow:  1px 1px 0px #000 , -1px 1px 0px #000, -1px -1px 0px #000, 1px -1px 0px #000; }' : '',
            // resize the headers so level is the same size as avatar
            CONFIG.hideLevel.move ? '.data-row.head-row .head-column[column="level"] { width: 2.5rem; }' : '',
            // remove level column
            CONFIG.hideLevel.enabled ? '.data-row.body-row .data-column[column="level"] { display: none; }' : '',
            CONFIG.hideLevel.enabled && !CONFIG.hideLevel.move ? '.data-row.head-row .data-column[column="level"] { display: none; }' : '',
            // reduce line height to fit two lines of text in the row
            '.data-column[column="player_league_points"] { text-align: right; line-height: 15px; }',
        ].join(' ');
        document.head.appendChild(sheet);
    }

    function getNextBoosterExpiration() {
        const maxNameLength = 12;
        let next = opponents_list.reduce((next, object) => {
                if (object.can_fight
                    && object.boosters.length
                    && object.boosters[0].expiration * 1000 < next.expiration) {
                    next.expiration = object.boosters[0].expiration * 1000;
                    next.name = object.nickname.length > maxNameLength
                        ? `${object.nickname.substring(0, maxNameLength - 1)}...`
                        : object.nickname;
                    next.rank = object.place;
                }
                return next;
            }, { name:'', rank: 0, expiration: Infinity });

        next.row = (() => {
            for (let row of document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row')) {
                const rank = parseInt(row.querySelector('.data-column[column="place"]').innerHTML);

                if (rank === next.rank) {
                    return row;
                }
            }
        })();

        return next;
    }

    function createBoosterCountdown() {
        const next = getNextBoosterExpiration();
        if (next.expiration === Infinity) {
            info('no boosted unfought opponents available')
            return;
        }
        // if Zoo's script is used place the booster timer
        // to the left of the record button otherwise to
        // the left of the league end timer
        const recordLeague = document.querySelector('#leagues .record_league');
        const insert = recordLeague ?? document.querySelector('#leagues .league_end_in');

        let div1 = document.createElement('div');
        insert.before(div1);
        div1.classList.add('booster-timer');
        let div2 = document.createElement('div');
        div1.appendChild(div2)
        div2.classList.add('season-timer', 'timer');

        let p = document.createElement('p');
        div2.appendChild(p);
        p.innerHTML = `Boosters expire<br>${next.name} (${next.rank})<br>`;
        p.style.textAlign = 'center';
        p.onclick = () => {
            // click on text will select the opponent row
            next.row.click();
        }

        let span = document.createElement('span');
        p.appendChild(span);
        span.innerHTML = `${FORMAT.time(next.expiration)}`;
        span.style.color = '#2296e4';

        const updateTimer = setInterval(function() {
            const now = new Date().getTime();
            const timeLeft = PAGE_LOAD_TS + next.expiration - now;
            if (timeLeft <= 0) {
                clearInterval(updateTimer);
                span.innerHTML = "EXPIRED";
                p.onclick = () => {
                    // after the boosters expire a click will also reload the league
                    next.row.click();
                    window.location.reload();
                }
                if (CONFIG.boosterTimer.sound) {
                    playUnboostSound();
                }
            } else {
                span.innerHTML = `${FORMAT.time(timeLeft)}`;
            }
        }, 1000);
    }

    function calculateChanges(opponentData, opponentStats) {
        updateScores(opponentData);

        updateStats(opponentStats);

        if (CONFIG.usedTeams.enabled) {
            updateUsedTeams(opponentData, opponentStats);
        }
    }

    function writeTable() {
        if (CONFIG.hideLevel.move) {
            addLevelToAvatar();
            if (!CONFIG.hideLevel.moveDone) {
                // swap lvl and name header to have lvl above the avatar
                let headers = document.querySelector('#leagues .league_table .data-list .data-row.head-row');
                let lvl = headers.querySelector('.data-column[column="level"]')
                let name = headers.querySelector('.data-column[column="nickname"]')
                headers.removeChild(lvl);
                name.before(lvl);
                CONFIG.hideLevel.moveDone = true;
            }
        }

        writeScores();

        if (CONFIG.average.enabled) {
            addAverageColumn();
        }

        if (CONFIG.activeSkill.enabled) {
            markActiveSkill();
        }

        if (CONFIG.usedTeams.enabled) {
            writeTeams();
        }

        writeStats();
    }

    function updateScores(opponentData) {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                const score = OPPONENT_DETAILS_BY_ID[id].player_league_points;
                const oldScore = opponentData[id].score || 0;
                const oldLostPoints = opponentData[id].totalLostPoints || 0;

                const gainedScore = score - oldScore;

                let newLostPoints = 25 - (((gainedScore + 24) % 25) + 1);
                let totalLostPoints = oldLostPoints + newLostPoints;

                // no need to guess your own
                if (id === MY_ID) {
                    const correction = MY_LOST_POINTS - totalLostPoints;
                    if (correction && gainedScore === 0) {
                        // this fixes a small inconsistency that can happen if you share
                        // the storage repo with someone who is in your league
                        opponentData[id].lastLostPoints += correction;
                        opponentData[id].totalLostPoints += correction;
                        GITHUB_PARAMS.needsUpdate = true;
                    }
                    totalLostPoints = MY_LOST_POINTS;
                    newLostPoints = totalLostPoints - oldLostPoints;
                }

                if (gainedScore > 0) {
                    opponentData[id] = {
                        ...opponentData[id],
                        score,
                        totalLostPoints,
                        lastDiff: gainedScore,
                        lastLostPoints: newLostPoints,
                        lastChangeTime: PAGE_LOAD_TS
                    }
                    GITHUB_PARAMS.needsUpdate = true;
                }

                const average = score ? 25 * score / (score + totalLostPoints) : 0;

                let changes = {
                    average: FORMAT.average(average),
                    averageColor: getAverageColor(average),
                    color: getScoreColor(totalLostPoints),
                    conditions: {},
                }

                if (LEAGUE_ENDING && CONFIG.screenshot.enabled) {
                    // since the league is about to end, calculate average and lost points as if all fights are done
                    const finalAverage = 25 * score / MAX_SCORE;
                    const finalLostPoints = MAX_SCORE - score;
                    changes.average = FORMAT.average(finalAverage);
                    changes.averageColor = getAverageColor(finalAverage);
                    changes.color = getScoreColor(finalLostPoints);
                    changes.pointHTML = `${FORMAT.score(score)}<br>${FORMAT.score(-finalLostPoints || 0)}` // this avoids -0, signDisplay 'negative' isn't supported by old firefox versions
                } else if (gainedScore > 0) {
                    changes.conditions.update = true;
                    // write score change and newly lost points
                    changes.pointHTML = `+${opponentData[id].lastDiff}<br>${-opponentData[id].lastLostPoints}`;
                    changes.tooltip = `Total Score: ${opponentData[id].score}` +
                                    `<br>Total Lost Points: ${opponentData[id].totalLostPoints}`;
                } else {
                    // add lost points below score
                    changes.pointHTML = `${FORMAT.score(score)}<br>${FORMAT.score(-totalLostPoints || 0)}` // this avoids -0, signDisplay 'negative' isn't supported by old firefox versions

                    const lastDiff = opponentData[id].lastDiff || 0;
                    if (lastDiff > 0) {
                        changes.conditions.addChangeTime = true;
                        changes.lastChangeTime = opponentData[id].lastChangeTime;
                        changes.tooltip = `Last Score Diff: ${lastDiff}` +
                            `<br>Last Lost Points: ${opponentData[id].lastLostPoints}`;
                    }
                }

                OPPONENT_DETAILS_BY_ID[id].HHLT.score = changes;
            }
        );
    }

    function writeScores() {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                const changes = OPPONENT_DETAILS_BY_ID[id].HHLT.score;

                if (CONFIG.scoreColor.enabled) {
                    if (CONFIG.scoreColor.rank) {
                        opponentRow.querySelector('.data-column[column="place"]').style.color = changes.color;
                    }
                    if (CONFIG.scoreColor.name) {
                        // remove clubmate class from League++ so clubmates get colored correctly too
                        opponentRow.querySelector('.data-column[column="nickname"]').classList.remove("clubmate");
                        opponentRow.querySelector('.data-column[column="nickname"]').style.color = changes.color;
                    }
                    if (CONFIG.scoreColor.level) {
                        opponentRow.querySelector('.data-column[column="level"]').style.color = changes.color;
                    }
                    if (CONFIG.scoreColor.points) {
                        opponentRow.querySelector('.data-column[column="player_league_points"]').style.color = changes.color;
                    }
                }

                if (changes.conditions.update) {
                    opponentRow.querySelector('.data-column[column="player_league_points"]').style.color = "#16ffc4";
                }

                opponentRow.querySelector('.data-column[column="player_league_points"]').innerHTML = changes.pointHTML;
                if (changes.tooltip){
                    if (changes.conditions.addChangeTime) {
                        opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute('tooltip', changes.tooltip + `<br>${FORMAT.time(Date.now() - changes.lastChangeTime)} ago`);
                    } else {
                        opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute('tooltip', changes.tooltip);
                    }
                }
            }
        );
    }

    function updateStats(opponentStats) {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                if (!opponentStats[id]) { opponentStats[id] = {}; }

                const STATS = ['damage', 'remaining_ego', 'defense', 'chance'];

                let allStatChanges = {};

                for (const i in STATS) {
                    const stat = STATS[i];

                    let statChanges = { conditions: {} };
                    const value = OPPONENT_DETAILS_BY_ID[id].player[stat];
                    const oldValue = opponentStats[id][stat]?.value || 0;
                    let lastDiff = opponentStats[id][stat]?.lastDiff || 0;
                    let lastChangeTime = opponentStats[id][stat]?.lastChangeTime || 0;

                    const statDiff = value - oldValue;
                    const percentage = value > 0 ? (100 * statDiff) / value : 0;
                    const lastPercentage = oldValue > 0 ? (100 * lastDiff) / oldValue : 0;

                    if (oldValue && Math.abs(statDiff) > 100) { // ignore changes < 100
                        lastDiff = statDiff;
                        lastChangeTime = PAGE_LOAD_TS;
                        statChanges.tooltip = `Last Stat Diff: ${FORMAT.statDiff(statDiff)} (${FORMAT.statPercent(percentage)}%)`;
                    } else if (lastChangeTime > 0) {
                        statChanges.tooltip = `Last Stat Diff: ${FORMAT.statDiff(lastDiff)} (${FORMAT.statPercent(lastPercentage)}%)`;
                    } else {
                        statChanges.conditions.neverChanged = true;
                    }

                    statChanges.conditions.positiveDiff = lastDiff > 0;
                    statChanges.lastChangeTime = lastChangeTime
                    opponentStats[id][stat] = {value, lastDiff, lastChangeTime};
                    allStatChanges[stat] = statChanges;
                }

                OPPONENT_DETAILS_BY_ID[id].HHLT.stats = allStatChanges;
            }
        );
    }

    function writeStats() {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                const STAT_ELEMENT_MAP = {
                    'damage': {'div': '#player_attack_stat', 'span': '#stats-damage'},
                    'remaining_ego': {'div': '#player_ego_stat', 'span': '#stats-ego'},
                    'defense': {'div': '#player_defence_stat', 'span': '#stats-defense'},
                    'chance': {'div': '#player_harmony_stat', 'span': '#stats-chance'},
                };

                for (const stat in STAT_ELEMENT_MAP) {
                    let statChanges = OPPONENT_DETAILS_BY_ID[id].HHLT.stats[stat];

                    if (statChanges.conditions.neverChanged) {
                        opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute('tooltip', 'No change since<br>league start');
                    } else {
                        const timeDiff = Date.now() - statChanges.lastChangeTime;

                        const statColor = getStatColor(timeDiff, statChanges.conditions.positiveDiff);
                        if (timeDiff < 10 * 60 * 1000) { // only highlight changes in the last 10 minutes
                            opponentRow.querySelector(STAT_ELEMENT_MAP[stat].span).style.color = statColor;
                        }
                        opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute('tooltip',
                            statChanges.tooltip
                            + `<br>${FORMAT.time(timeDiff)} ago`);
                    }
                }
            }
        );
    }

    function markActiveSkill() {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                const center = OPPONENT_DETAILS_BY_ID[id].player.team.girls[0];

                if (center.skill_tiers_info['5']?.skill_points_used) {
                    const {type, id, color} = getSkillByElement(center.girl.element, CONFIG.activeSkill.ocd);

                    if (CONFIG.activeSkill.noIcon) {
                        applySkillColor(opponentRow.querySelector('.data-column[column="nickname"]'), color);
                    } else {
                        const tooltip = `${type} ${center.skills[id].skill.display_value_text}`;
                        addSkillIcon(opponentRow.querySelector('.data-column[column="team"]').firstElementChild, type, tooltip);
                    }
                }
            }
        );
    }

    function applySkillColor(nickname, color) {
        // remove clubmate class from League++ so clubmates get colored correctly too
        nickname.classList.remove("clubmate");
        nickname.style.color = color;
    }

    function addSkillIcon(team_icons, type, tooltip) {
        // move the icons a little closer together
        team_icons.lastElementChild.style.marginRight = '-0.15rem';
        if (team_icons.childElementCount === 2) {
            // this will overlap the two theme elements to save space
            team_icons.lastElementChild.style.marginLeft = '-0.66rem';
        }
        team_icons.appendChild(getSkillIcon(type, {tooltip}));
    }

    function updateUsedTeams(opponentData, opponentStats) {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                const opponent = OPPONENT_DETAILS_BY_ID[id];
                let tooltip = document.createElement('div');

                // no need to collect your own teams
                if (id !== MY_ID) {
                    let teamsSet = opponentData[id].teams?.length ? new Set(opponentData[id].teams) : new Set();
                    const opponentTeam = opponent.player.team;

                    let type = opponentTeam.girls[0].skill_tiers_info['5']?.skill_points_used
                        ? getSkillByElement(opponentTeam.girls[0].girl.element).type
                        : null;
                    const currentTeam = JSON.stringify({theme: opponentTeam.theme, type: type});
                    if (!teamsSet.has(currentTeam)) {
                        teamsSet.add(currentTeam);
                        GITHUB_PARAMS.needsUpdate = true;
                    }
                    const teams = Array.from(teamsSet).sort();

                    opponentData[id].teams = teams;
                    let text1 = document.createElement('p');
                    text1.innerText = 'Used Teams:';
                    tooltip.appendChild(text1);

                    let table = document.createElement('div');
                    tooltip.appendChild(table);
                    table.style.display = 'grid';
                    table.style.justifyContent = 'center';
                    table.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(teams.length))}, 50px)`;
                    teams.forEach((teamJson) => {
                        let team = JSON.parse(teamJson);
                        let div = document.createElement('div');
                        team.theme.split(',').forEach((element) => {
                            let elementIcon = getElementIcon(element,
                                {style: 'height: 16px; width: 16px;',});
                            div.appendChild(elementIcon);
                        });
                        if (div.childElementCount === 2) {
                            // overlap dual elements
                            div.firstElementChild.style.marginRight = '-7px';
                        }
                        if (team.type && team.type !== 'none') {
                            let skillIcon = getSkillIcon(team.type,
                                {style: 'height: 16px; width: 16px;',});
                            div.appendChild(skillIcon);
                        }
                        table.appendChild(div)
                    })
                }
                let powerChange = { conditions: {} };
                const teamPower = opponent.team;
                const oldTeamPower = opponentStats[id]['power']?.teamPower || 0;
                let lastDiff = opponentStats[id]['power']?.lastDiff || 0;
                let lastChangeTime = opponentStats[id]['power']?.lastChangeTime || 0;

                const statDiff = teamPower - oldTeamPower;
                const percentage = teamPower > 0 ? (100 * statDiff) / teamPower : 0;
                const lastPercentage = oldTeamPower > 0 ? (100 * lastDiff) / oldTeamPower : 0;

                let text2 = document.createElement('p');
                tooltip.appendChild(text2);
                if (oldTeamPower && statDiff) {
                    lastDiff = statDiff;
                    lastChangeTime = PAGE_LOAD_TS;
                    powerChange.conditions.addTime = true;
                    text2.innerHTML = `Last Power Diff:<br> ${FORMAT.statDiff(statDiff)} (${FORMAT.statPercent(percentage)}%)`;
                } else if (lastChangeTime > 0) {
                    powerChange.conditions.addTime = true;
                    text2.innerHTML = `Last Power Diff:<br>${FORMAT.statDiff(lastDiff)} (${FORMAT.statPercent(lastPercentage)}%)`;
                } else {
                    text2.innerHTML = 'No power change<br>since league start';
                }
                powerChange.conditions.positiveDiff = lastDiff > 0;
                powerChange.lastChangeTime = lastChangeTime;

                // XXX apparently the equipment is always correct for the player and always wrong for the opponents
                // regardless if the bug is active or not so this doesn't work to detect the bug

                // const girl1ArmorString = JSON.stringify(opponent.player.team.girls[0].armor);
                // powerChange.conditions.eqBug = opponent.player.team.girls.reduce((bugged, girl) => { return bugged && JSON.stringify(girl.armor) === girl1ArmorString }, true);

                opponentStats[id]['power'] = {teamPower, lastDiff, lastChangeTime};
                opponent.HHLT.teams = { tooltip: tooltip.innerHTML, powerChange};
            }
        );
    }

    function writeTeams() {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                let teamPower = opponentRow.querySelector('.data-column[column="team"]').lastElementChild;

                const opponent = OPPONENT_DETAILS_BY_ID[id];
                const powerChange = opponent.HHLT.teams.powerChange;
                const timeDiff = Date.now() - powerChange.lastChangeTime;

                let tooltip = opponent.HHLT.teams.tooltip;
                if (powerChange.conditions.addTime) {
                    tooltip += `${FORMAT.time(timeDiff)} ago`;
                }
                if (powerChange.conditions.eqBug) { // always false since the detection doesn't work
                    tooltip += `<br>Equipment Bugged!`;
                    // this gives the team power a negative look
                    teamPower.style.color = `#000`;
                    const outlineColor = (timeDiff > 10 * 60 * 1000)
                        ? '#ffffff'
                        : getStatColor(timeDiff, powerChange.conditions.positiveDiff);
                    teamPower.style.textShadow = `1px 1px 0px ${outlineColor}, -1px 1px 0px ${outlineColor}, -1px -1px 0px ${outlineColor}, 1px -1px 0px ${outlineColor}`;
                } else if (timeDiff < 10 * 60 * 1000) {
                    const statColor = getStatColor(timeDiff, powerChange.conditions.positiveDiff);
                    teamPower.setAttribute('style', `color: ${statColor}`);
                }
                teamPower.setAttribute('tooltip', tooltip);
            }
        );
    }

    function addAverageColumn() {
        const tableHeader = document.querySelector('#leagues .league_table .data-list .data-row.head-row');
        // this will run after every sorting of the table so the header
        // only needs to be created the first time
        if (!tableHeader.querySelector('.data-column[column="average"]')) {

            const pointsColumn = tableHeader.querySelector('.data-column[column="player_league_points"]');

            let span = document.createElement('span');
            span.innerHTML = 'Average';

            let avgColumn = document.createElement('div');
            avgColumn.classList.add('data-column', 'head-column');
            avgColumn.setAttribute('column', 'average');
            avgColumn.style.textAlign = 'center';
            avgColumn.appendChild(span);
            avgColumn.style.minWidth = '1.8rem';

            pointsColumn.after(avgColumn);
        }

        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));
                const pointsColumn = opponentRow.querySelector('.data-column[column="player_league_points"]');

                let avgColumn = document.createElement('div');
                avgColumn.classList = pointsColumn.classList;
                avgColumn.setAttribute('column', 'average');
                avgColumn.style.minWidth = '1.8rem';
                avgColumn.style.textAlign = 'center';

                if (CONFIG.average.color) {
                    avgColumn.style.color = OPPONENT_DETAILS_BY_ID[id].HHLT.score.averageColor;
                }

                avgColumn.innerHTML = OPPONENT_DETAILS_BY_ID[id].HHLT.score.average;

                pointsColumn.after(avgColumn);
            }
        );
    }

    function addLevelToAvatar() {
        document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
            opponentRow => {
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                let avatar = opponentRow.querySelector('.data-column[column="nickname"] .square-avatar-wrapper');
                // some scripts remove the avatar
                if (!avatar) {
                    CONFIG.hideLevel.move = false;
                    return;
                }
                avatar.style.position = 'relative';
                let lvl = document.createElement('div');
                lvl.innerHTML = OPPONENT_DETAILS_BY_ID[id].level;
                lvl.setAttribute('style', `width: 100%; position: absolute; bottom: -0.2rem; text-align: center; font-size: 0.66rem`);
                avatar.appendChild(lvl);
            }
        );
    }

    function getScoreColor(lostPoints) {
        if (lostPoints <= 25) {
            return "#ec0039"; // mythic
        } else if (lostPoints <= 50) {
            return "#d561e6"; // legendary
        } else if (lostPoints <= 100) {
            return "#ffb244"; // epic
        } else if (lostPoints <= 200) {
            return "#32bc4f"; // rare
        } else {
            return "#676767"; // grey
        }
    }

    function getAverageColor(average) {
        if (average >= 24.9) {
            return "#ec0039"; // mythic
        } else if (average >= 24.7) {
            return "#d561e6"; // legendary
        } else if (average >= 24.4) {
            return "#ffb244"; // epic
        } else if (average >= 24) {
            return "#32bc4f"; // rare
        } else {
            return "#676767"; // grey
        }
    }

    function getStatColor(time, positive) {
        return (time < 60 * 1000)
            ? (positive ? "#ec0039" : "#32bc4f")
            : (positive ? "#ff8aa6" : "#a4e7b2"); // lighter highlight color for changes older than 1 minute
    }

    function getSkillByElement(element, ocd = false) {
        switch (element) {
            case 'fire':
            case 'water':
                return {type: 'execute', id: 14, color: ocd ? '#66cd00' : '#32bc4f'};
            case 'nature':
            case 'psychic':
                return {type: 'reflect', id: 13, color: ocd ? '#b968e6' : '#ec0039'};
            case 'light':
            case 'stone':
                return {type: 'shield', id: 12, color: ocd ? '#ffa500' : '#ffb244'};
            case 'darkness':
            case 'sun':
                return {type: 'stun', id: 11, color: ocd ? '#14b4d9' : '#d561e6'};
            default:
                throw `Unknown element: ${element}`;
        }
    }

    function getSkillIcon(type, attrs = null) {
        let skill_icon = document.createElement('img');
        skill_icon.classList.add('team-theme', 'icon');
        skill_icon.src = getSkillIconSrc(type);
        if (attrs) Object.entries(attrs).forEach(attr => skill_icon.setAttribute(...attr));
        return skill_icon;
    }

    function getSkillIconSrc(type) {
        switch (type) {
            case 'execute':
                return 'https://hh.hh-content.com/pictures/design/girl_skills/pvp3_active_skills/execute_icon.png';
            case 'reflect':
                return 'https://hh.hh-content.com/pictures/design/girl_skills/pvp3_active_skills/reflect_icon.png';
            case 'shield':
                return 'https://hh.hh-content.com/pictures/design/girl_skills/pvp4_trigger_skills/shield_icon.png';
            case 'stun':
                return 'https://hh.hh-content.com/pictures/design/girl_skills/pvp4_trigger_skills/stun_icon.png';
            default:
                throw `Unknown skill type: ${type}`;
        }
    }

    function getElementIcon(element, attrs = null) {
        let element_icon = document.createElement('img');
        element_icon.classList.add('team-theme', 'icon');
        element_icon.src = getElementIconSrc(element);
        if (attrs) Object.entries(attrs).forEach(attr => element_icon.setAttribute(...attr));
        return element_icon;
    }

    function getElementIconSrc(element) {
        switch (element) {
            case '':
                return 'https://hh.hh-content.com/pictures/girls_elements/Multicolored.png';
            case 'darkness':
                return 'https://hh.hh-content.com/pictures/girls_elements/Dominatrix.png';
            case 'fire':
                return 'https://hh.hh-content.com/pictures/girls_elements/Eccentric.png';
            case 'light':
                return 'https://hh.hh-content.com/pictures/girls_elements/Submissive.png';
            case 'nature':
                return 'https://hh.hh-content.com/pictures/girls_elements/Exhibitionist.png';
            case 'psychic':
                return 'https://hh.hh-content.com/pictures/girls_elements/Voyeurs.png';
            case 'stone':
                return 'https://hh.hh-content.com/pictures/girls_elements/Physical.png';
            case 'sun':
                return 'https://hh.hh-content.com/pictures/girls_elements/Playful.png';
            case 'water':
                return 'https://hh.hh-content.com/pictures/girls_elements/Sensual.png';
            default:
                throw `Unknown element: ${element}`;
        }
    }

    function getFormatters() {
        let formatters = {};

        formatters.score = Intl.NumberFormat('en',).format;

        formatters.statDiff = Intl.NumberFormat('en', {
                notation: 'compact',
                signDisplay: "exceptZero"}).format;

        formatters.statPercent = Intl.NumberFormat('en', {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
                signDisplay: "exceptZero"}).format;

        formatters.average = Intl.NumberFormat('en', {
                maximumFractionDigits: 2}).format;

        formatters.time = (millis) => {
            const days = Math.floor(millis / 1000 / 60 / 60 / 24);
            let show = days > 0;
            const d = show ? days + 'd ' : '';

            const hours = Math.floor(millis / 1000 / 60 / 60) % 24;
            show |= hours > 0;
            const h = show ? hours + 'h ' : '';

            const minutes = Math.floor(millis / 1000 / 60) % 60;
            show |= minutes > 0;
            const m = show ? minutes + 'm ' : '';

            const seconds = Math.floor(millis / 1000) % 60;
            const s = seconds + 's';

            return d + h + m + s;
        }

        return formatters;
    }

    function getWeekName(epochMillis) {
        // returns a string containing the year and week number of the timestamp
        // see https://weeknumber.com/how-to/javascript
        let date = new Date(epochMillis);
        date.setHours(0, 0, 0, 0);
        // Thursday in current week decides the year.
        date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
        const year = date.getFullYear();
        // January 4 is always in week 1.
        const week1 = new Date(year, 0, 4);
        // Adjust to Thursday in week 1 and count number of weeks from date to week1.
        const weekNumber = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
        return year + 'W' + (weekNumber < 10 ? '0' : '') + weekNumber;
    }

    async function mergeLocalAndGithubData(localData) {
        const github = await readFromGithub();
        // merge local storage data into the data from GitHub to not lose data if sync was previously off or
        // temporarily unavailable
        if (JSON.stringify(localData) !== JSON.stringify(github.data)) {
            for (const [id, local] of Object.entries(localData)) {
                if (!github.data[id]
                    || github.data[id].totalLostPoints < local.totalLostPoints // lost points are more accurate
                    || (github.data[id].totalLostPoints === local.totalLostPoints
                        && github.data[id].score < local.score) // lost points are as good and score is newer
                ) {
                    GITHUB_PARAMS.needsUpdate = true;
                    github.data[id] = local;
                }
            }
        }
        return github;
    }

    async function readFromGithub() {
        info(`reading ${GITHUB_PARAMS.path}`);
        const response = await fetch(GITHUB_PARAMS.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${GITHUB_PARAMS.token}`,
                'If-None-Match': '' // workaround for avoiding cached data
            }
        });
        if (response.status !== 200) {
            throw response.status;
        }
        const data = await response.json();
        return {
            data: JSON.parse(atob(data.content)), // file content needs to be decoded from base64
            sha: data.sha, // required to write an update later
        };
    }

    function commitMessage(action) {
        return `${(new Date()).toISOString()} [${shared.Hero.infos.name}] ${action} ${GITHUB_PARAMS.path}`;
    }

    async function commitNewFile() {
        info(`creating ${GITHUB_PARAMS.path}`);
        const message = commitMessage('create');
        const content = btoa('{}'); // needs to be encoded in base64
        await writeToGithub(content, message);
    }

    async function commitUpdate(data) {
        info(`updating ${GITHUB_PARAMS.path}`);
        const message = commitMessage('update');
        const content = btoa(JSON.stringify(data, null, 2)); // needs to be encoded in base64
        await writeToGithub(content, message, GITHUB_PARAMS.sha);
    }

    async function writeToGithub(content, message, sha = null) {
        let data = {
            message: message,
            content: content,
        }
        if (sha) {
            data.sha = sha // to write an update sha is required
        }
        await fetch(GITHUB_PARAMS.url, {
            method: 'PUT',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${GITHUB_PARAMS.token}`,
            },
            body: JSON.stringify(data),
        });
    }

    function getHHPlusPlusConfig() {
        return (async () => {
            await new Promise($);
            return window.hhPlusPlusConfig;
        })();
    }

    async function loadConfig() {
        // defaults
        let config = {
            githubStorage:
                { enabled: true },
            scoreColor:
                { enabled: true, rank: false, name: false, level: false, points: true },
            activeSkill:
                { enabled: false, noIcon: false, ocd: false },
            usedTeams:
                { enabled: false },
            average:
                { enabled: false, color: false },
            hideLevel:
                { enabled: false, move: false },
            screenshot:
                { enabled: true },
            boosterTimer:
                { enabled: true, sound: false },
        };

        // changing config requires HH++
        const hhPlusPlusConfig = await getHHPlusPlusConfig();
        if (hhPlusPlusConfig == null) {
            return config;
        }

        hhPlusPlusConfig.registerGroup({
            key: 'LeagueTracker',
            name: 'League Tracker'
        });

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'githubStorage',
                label: 'Sync data to GitHub (see <a href="https://github.com/xnh0x/HH-League-Tracker" target="_blank">README</a>).',
                default: true,
            },
            run() {
                config.githubStorage = {
                    enabled: true,
                };
            },
        });
        config.githubStorage.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'scoreColor',
                label: `Color players based on the amount of lost points<br>`
                    + ` <span style="color: ${getScoreColor(25)}">&le;25</span>`
                    + ` <span style="color: ${getScoreColor(50)}">&le;50</span>`
                    + ` <span style="color: ${getScoreColor(100)}">&le;100</span>`
                    + ` <span style="color: ${getScoreColor(200)}">&le;200</span>`,
                default: true,
                subSettings: [
                    { key: 'rank', default: false, label: 'Rank' },
                    { key: 'name', default: false, label: 'Name' },
                    { key: 'level', default: false, label: 'Level' },
                    { key: 'points', default: true, label: 'Points' },
                ],
            },
            run(subSettings) {
                config.scoreColor = {
                    enabled: true,
                    rank: subSettings.rank,
                    name: subSettings.name,
                    level: subSettings.level,
                    points: subSettings.points,
                };
            },
        });
        config.scoreColor.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'activeSkill',
                label: 'Add active skill icon to the team column',
                default: true,
                subSettings: [
                    { key: 'noIcon', default: false,
                        label: `Instead of an icon apply color to the player name<br>`
                            + ` <span style="color: #ec0039">RFL</span>`
                            + ` <span style="color: #d561e6">STN</span>`
                            + ` <span style="color: #ffb244">SHD</span>`
                            + ` <span style="color: #32bc4f">EXE</span>`,
                    },
                    { key: 'ocd', default: false,
                        label: `Use the same colors as OCD <br>`
                            + ` <span style="color: #b968e6">RFL</span>`
                            + ` <span style="color: #14b4d9">STN</span>`
                            + ` <span style="color: #ffa500">SHD</span>`
                            + ` <span style="color: #66cd00">EXE</span>`,
                    },
                ],
            },
            run(subSettings) {
                config.activeSkill = {
                    enabled: true,
                    noIcon: subSettings.noIcon || subSettings.ocd,
                    ocd: subSettings.ocd,
                };
                config.scoreColor.name &= !subSettings.noIcon;
            },
        });
        config.activeSkill.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'average',
                label: 'Add column with current average',
                default: false,
                subSettings: [
                    { key: 'color', default: false,
                        label: `Use colors<br>`
                            + ` <span style="color: ${getAverageColor(24.9)}">&ge;24.9</span>`
                            + ` <span style="color: ${getAverageColor(24.7)}">&ge;24.7</span>`
                            + ` <span style="color: ${getAverageColor(24.4)}">&ge;24.4</span>`
                            + ` <span style="color: ${getAverageColor(24)}">&ge;24</span>`,
                    },
                ],
            },
            run(subSettings) {
                config.average = {
                    enabled: true,
                    color: subSettings.color,
                };
            },
        });
        config.average.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'hideLevel',
                label: 'Remove level column',
                default: false,
                subSettings: [
                    { key: 'move', default: false,
                        label: 'Show level on avatar',
                    },
                ],
            },
            run(subSettings) {
                config.hideLevel = {
                    enabled: true,
                    move: subSettings.move,
                };
            },
        });
        config.hideLevel.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'usedTeams',
                label: 'Track used teams and display team power changes',
                default: false,
            },
            run() {
                config.usedTeams = {
                    enabled: true,
                };
            },
        });
        config.usedTeams.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'screenshot',
                label: 'If the league is about to end (<5m) calculate average and lost points as if all fights are done',
                default: true,
            },
            run() {
                config.screenshot = {
                    enabled: true,
                };
            },
        });
        config.screenshot.enabled = false;

        hhPlusPlusConfig.registerModule({
            group: 'LeagueTracker',
            configSchema: {
                baseKey: 'boosterTimer',
                label: 'Show a timer until the next unfought opponent\'s boosters expire' ,
                default: false,
                subSettings: [
                    { key: 'sound', default: false,
                        label: 'Play a sound once they do',
                    },
                ],
            },
            run(subSettings) {
                config.boosterTimer = {
                    enabled: true,
                    sound: subSettings.sound,
                };
            },
        });
        config.boosterTimer.enabled = false;

        hhPlusPlusConfig.loadConfig();
        hhPlusPlusConfig.runModules();

        return config;
    }

    function playUnboostSound() {
        const sound = new Audio("data:audio/wav;base64,UklGRsqKAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YRSHAAD/////AQAAAAAAAQAAAAAAAQD//wAAAAAAAAAAAQAAAAAAAAAAAAEAAAABAAAAAAD//wEAAAAAAAEAAgABAAEA//8AAAAAAAAAAAAAAAAAAAAAAQD//wAAAAAAAAAAAAD//wAAAQD///////8AAAAAAAABAAEAAQABAAAAAAD//wEAAQABAAAAAAAAAP////8AAAEAAAAAAAAA////////AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8AAP//AAD///7/AAAAAAAA//8BAAAAAQAAAAEAAAAAAAAAAAAAAAAA//8AAAEAAAAAAAEA//8AAAAA//8AAAAAAQAAAAAA//8AAP7/AAABAAAAAQABAP//AAAAAAEAAAAAAAEAAQD/////AAAAAAEAAAABAAAAAAABAAEAAAD//wAAAAAAAP//AAAAAP//AAAAAP//AAAAAAAAAAABAAAA//8AAAAAAAAAAAAAAAAAAAAAAAAAAP//AQAAAAAAAAABAAEAAQAAAP//AAAAAAAA//8BAAAA//8BAAAAAAD//wEAAAAAAAEAAAD/////AAAAAAAA//8AAAAA//8CAAEA//8CAAEA/////////////wAAAAABAAAAAQD//wEAAAABAP7/AAD//wAAAQABAP//AAAAAAAA//8BAAAAAQAAAAAAAAABAP//AAAAAAIAAAACAAAAAAAAAAEA/v8AAAEAAgD//wEAAAAAAP//AQAAAAEA//8AAP//AAD//wAAAAABAP//AQD//wEA//8BAP//AQD9/wEA//8CAP//AAD//wIA/v8AAP//AgD9/wEA//8CAP//AQD//wEA/v8BAAAAAQD//wAA//8CAAAAAQD+/wEA/v8DAP//AQD9/wMA/v8CAP7/AQD9/wIA/f8CAP7/AwD9/wIA/v8CAP3/AgD9/wIA//8DAP7/AwD+/wIA/f8DAP//AgD9/wMA/v8DAP3/AwD9/wEA/f8EAP3/BAD7/wQA/P8EAP7/BAD8/wQA+/8EAP3/BAD8/wUA/P8EAPz/BQD8/wQA+v8GAPv/BwD7/wUA+v8FAPr/BgD6/wcA+v8GAPn/BgD5/wYA9/8HAPf/CQD3/wkA9/8JAPf/CgD3/woA9P8LAPT/DADz/w0A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lv+X/5n/mv+b/5//nv+h/6L/o/+l/6X/qP+q/6v/q/+u/67/sP+x/7H/sv+0/7X/tv+3/7n/uv+5/7z/vf+//7//wP/A/8L/wv/E/8P/xf/F/8j/x//K/8v/yv/O/8z/zf/O/8//0P/P/9D/0v/T/9P/1P/U/9b/1v/W/9b/2f/W/9n/2v/a/9r/3P/c/9v/3P/d/97/3f/e/+D/4P/g/+D/4//j/+H/4v/j/+T/5P/j/+T/5v/m/+b/5v/m/+j/6P/o/+j/6P/o/+v/6v/p/+r/6v/r/+z/6//s/+z/7P/r/+7/7v/t/+7/7v/v/+7/7f/w//H/8f/w//H/7//w//D/8v/y//L/8v/x//P/8v/y//L/8v/0//T/8//0//T/9P/z//P/8//z//L/9P/2//X/9//2//f/9v/3//f/9v/2//f/9f/2//X/+P/4//f/+P/3//b/9//3//j/9//4//j/+P/3//j/+P/3//f/+f/6//v/+//6//r/+v/6//v/+f/7//r/+P/8//r/+v/5//v/+f/6//r/+f/6//r/+v/6//3//f/8//v//f/7//z//f/7//3//P/8//z//P/8//3//P/8//v//P/7//v//P/8//z//P/8//v/+//8//3//P/9//3//P/9//3/+//7//z//P/8//v//P/+//7//v////7//f/+//3////+///////9/wAA/v/9//3//v/9//7//v////7//f/+//7//v/+//7//v/+///////+//7//v/+//7//v/9//3//v/+//7////9//3////+//7////+///////+//3//v////7//v/9//3//v/+//3//v/+//7//v/9//7//v////3//v/+//7//v/9//z//f/+//7//v/+//3////+//7////9//3//v/+//7//v/+//3//v/+//7////+//7//v/+//7//v/+/////P/+//7//v/+//3////+//7//v/+//3////9//3//v/+//7//f/+//7//f/+//7//v////7////9/////v/+//7//v/+//7//v////3//v/+//7//v/+//7//v/+//3//v/+//7//v/9//7//v/+/wAA/v/+//7//v/+//7//v/+//7////8//3////+//3////+/////v/+//7///////7///////7//v/+//7///////7//v/+//7//v/+//7///////7//v////7//v/+//7//v/+///////+//3//v////7//f/+//7////+/////v/+/////v/+//7//v/+///////+/////v////7//f/9//7//v/+//7//v/9//3//v/+//7//v/9///////+//3//f/+/////f/9//7////+//7//f/9//7//v///////v/+//3//f/+//7//v/+//7//v/+/////v/+//3//v/+//3//f/+//7//v/+//7//f/+//7//f/+//7//f/+/////f/+//7//v/+//3//v///////v/+//7//v/9//7//v/+//7//v/+//z//v/+/////v/9//7////+//3//f/9//7//v/+//7//f/+//3///////7//f/+//3//v/+/////v/+//7//v/+/////v/+//3////+//3//P/+//7////+//7//v/+//7////9//7/AAD///7//v/+//7//v///wEA//8AAAAA//8AAAAAAAAAAAAAAAAAAAIAAAAAAAAA//8AAAEAAAAAAAAAAAAAAAEAAAABAAAAAQD//wEAAAD//wEA//8AAAAAAAD//wAAAAD//wAAAAD//wAAAAAAAAIAAAAAAAAAAAAAAP//AAABAAAAAAD//wAAAQAAAAAAAAAAAAAA/////wAAAAABAAEAAAABAP//AAD/////AAAAAP//AAAAAAAAAAAAAAAAAAAAAP//AQABAAEAAAAAAAAA///+/wAAAAAAAAAAAAABAAAA//8AAAEAAAAAAAAAAAAAAAAAAAD+/wAA//8BAAEAAAD/////AQABAAEA/////wEAAAAAAAAAAAAAAP//AAABAAEAAAAAAAEAAgD//wAA//8BAP//AAABAAEAAAAAAP////8AAAAA//8AAAAAAQAAAAAA/////wAAAAAAAAAA/////wAAAAAAAAEAAQABAAAA//8AAAEAAQABAAAAAAD/////AQD//wAAAQAAAAAAAAAAAAAAAAAAAAAA/////wAAAAAAAAAAAAD//wAAAQD//wAAAAD//wEAAAAAAAEA//8AAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAgAAAAAAAAABAAAAAQAAAAAAAQAAAAAAAgAAAAAAAAAAAAAAAAD//wAAAAABAP//AQAAAAAAAAAAAAAAAAAAAP//AAAAAP7/AAD//wAAAQAAAP//AAAAAAAAAAAAAAAAAAABAAAA/////wEAAAAAAP//AAAAAAAAAAAAAAAAAAABAAAAAAAAAAEA//8BAAAAAAAAAAAAAAAAAAAAAQABAAEAAAAAAAEAAQAAAAEA//8AAAEAAAAAAAAAAQAAAAAAAAD//wAAAQABAP//AAD//wEAAAAAAAAAAQD//wAAAAAAAAAAAAD//wEAAQAAAP//AAAAAP//AAAAAAAA//8AAAAAAAABAP////////////8AAAAA//8AAAAAAAAAAAEAAAD/////AAABAAAAAAABAAAAAAABAP//AQAAAAAAAQAAAAAA//8BAP//AAACAAAAAAAAAAAAAAABAAAAAAD//wAAAQAAAAAAAQABAAAAAAABAAAAAQAAAP7/AAD+/wAAAAAAAAEA//8AAAAAAQABAAAAAAAAAAAAAQAAAAAAAQABAP//AQAAAAAA//8AAAAA//8AAAAAAAABAAEAAAD//wAA/////wAAAQD//wAA//8AAAAA/////wAAAAAAAAAA//8BAAAA//8AAAEAAAD//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAEA//8BAAAA//8AAAEAAAAAAAEAAAAAAAEAAQAAAAAAAAAAAAAAAAAAAP////8BAAEAAAACAAAAAAD+/wAA//8AAP7/AAAAAAAAAAAAAAAAAAAAAAEAAAACAAAA//8BAAEAAAAAAP///////wEAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wAAAAAAAAAAAAD//wAAAAAAAAIAAAAAAAAAAAABAAEAAAAAAAEAAQAAAAAAAAABAAEA/v8AAP//AAAAAAAA//8AAP//AAAAAAAA/v8AAAEAAAAAAAAAAAAAAAAA//8AAP///v8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA//8BAP//AAAAAAEA//8AAAAAAQAAAAAAAAAAAAAAAQABAAAAAAAAAAAA//8AAAAAAQAAAAEAAAABAAAAAAAAAP//AgABAP////8AAAAAAAD//wAAAAAAAAAAAQABAAAAAAAAAAAA//8AAAAAAAAAAAAAAAD//wAA/////wEAAQAAAAAA//8AAAEAAAAAAP//AQD//wAAAAABAAEA//8AAAEA////////AQD//wEA/////wAAAAABAP//AQAAAAEAAAAAAP//AQAAAP//AQAAAAAAAAAAAP//AAABAAAAAAAAAAEAAAAAAP7/AQD//wAA//8AAAAAAAABAP//AQAAAP//AQAAAAEAAAAAAAAAAAABAP////8AAAEAAAABAAAAAAABAAAAAAD/////AAABAAAAAQD//wEAAAABAAAAAQAAAAAA/////wEAAAAAAAAA//8AAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8CAAAAAQAAAP//AQAAAP7/AAD/////AAABAP//AQAAAAEAAQAAAAAAAAAAAAAAAAAAAP////8AAP7/AAABAAAAAAD//wAAAAD//wAAAAAAAAEAAQD//wAAAAAAAAAAAAABAAEAAAACAP//AQAAAAAAAAAAAAAAAQAAAP7/AAD//wAAAQAAAAAAAAAAAP//AAAAAAEAAAAAAP//AQAAAP7///8AAAAAAAAAAP////8AAAEAAAD//wAAAAABAAEAAQAAAAAAAQABAAAAAAD//wEAAAAAAP//AAD//wAAAQAAAP//AgD//wAA//8AAP7/AAD//wAAAAAAAAAAAAAAAAAA//8BAAAAAQD///////8BAAEAAAAAAAEA//8AAAAAAQABAAEA//8AAP//AQAAAAEAAAAAAAAAAAD//wEA//8BAAEAAAD//wEA//8BAP//AQAAAAEA//8BAP//AAD//wEAAAACAP//AQD//wEA//8BAAAAAQD//wEA//8BAP7/AQD//wAAAAABAP//AQD//wEA//8CAP//AQD//wMA//8CAP3/AQD//wEA//8CAP3/AQD+/wMA//8CAP7/AAD//wEA//8CAP7/AQD+/wEA/v8DAP7/AQD+/wIA/v8CAP3/AgD+/wIA/v8CAP3/AgD9/wEA/v8DAP3/AwD+/wMA/f8EAP7/BAD8/wMA/P8EAP7/AwD9/wMA/P8EAPz/BAD9/wQA/P8FAPz/BAD7/wMA/P8FAPv/BAD7/wQA/P8EAPv/BAD7/wQA+/8FAPv/BgD7/wUA+f8FAPv/BgD7/wUA+/8HAPv/BgD5/wYA+f8HAPn/BwD5/wcA+v8HAPj/CAD4/wkA9/8KAPf/CAD3/wkA9/8KAPf/CQD3/woA9f8LAPX/CwD1/wsA9f8MAPT/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h/+I/4v/jf+P/4//k/+U/5b/l/+Z/5v/nP+d/6D/of+j/6T/pv+o/6n/qP+s/6r/rv+v/6//sP+y/7P/tf+3/7f/uP+5/7r/vP+9/77/vv/A/8D/wf/C/8T/w//E/8X/xv/J/8f/yf/K/8v/zP/M/87/zf/O/9D/0P/R/9L/0v/U/9P/1f/W/9b/1v/Y/9j/2f/Y/9r/2f/c/93/3P/a/9z/3v/e/97/4P/g/+D/4f/g/+H/4//i/+P/5f/j/+X/5P/l/+X/5v/m/+b/5f/o/+j/6P/o/+b/6P/q/+r/6v/q/+r/7P/t/+z/7P/t/+3/7P/t/+3/7f/v/+7/7v/u/+//8P/x//D/8P/x/+//8P/x//L/8//y//H/8v/z//H/8v/y//L/8//1//T/8//0//T/8//z//P/9P/0//T/9//1//b/9v/2//T/9v/3//b/9v/2//b/9v/2//j/+P/5//f/+P/4//j/+P/3//f/+P/4//r/9//4//j/+P/4//n/+//6//n/+v/6//j/+v/5//n/+f/5//n/+f/6//r/+v/7//v/+f/6//r/+v/6//r/+v/8//3//P/7//z/+//8//z/+//8//v//P/8//z//P/8//z//P/8//z//P/9//3//P/7//z//P/8//z//P/9//r//P/8//3//P/8//z//P/8//z//f/8//v//P/+//7//f/+//7////+//7//v/+//7//f/+//7////+//7//f////3//v////3//v/+//7//v/+//7///////7//v/+//7//f/+//7//v/+//7//v/+/////P/+//7//v/+//7//v/9//3//v/+//7////+//7//v/9//7//v////7//v/+//7//f/+/////P/+/////v/9//7//v/+//7//v/9//7//f/9//7//v/+/////f/+//7//v///////f/+/////v/+//7//v/+//3//f/9//7//f/+//3////+//7//f/9//////////3//v/+//7///////7//f/9//7////9/////v/+//7//v/9//7//v/+//z//v/+//7//v////7////+//7/AAD+/////v/9/////v/+//7//v////7//v/+//3////+//3//v/9//7//v/+//7//v/+//7//v/+//3//v/9//3//v/+//7//v////3//f/+//7//v/+/////v/+//7//v/+//3////9//3//v/8/////f/+//7//v/9//7//v/+//7//v/+//7//v/9//3//f/9//7//v/+//3//v/9//7//f/+//7//v/+//7//f////7//v/9//7//v/8//7//v////7//v/+/////v/+//7//P/+//7//v/9//7//f/+//7//v////7//v/+/////v/+//7//v/+//7//v/9//7//f////7//v/+//3//P/+//7//v/+//7//v/9//7//f/+//3//v/9//7//f////7//f/+/////v/9/////f/+/wAA/f/+/////f////7//f/+//3//v/9//7//f/9//7//f/+//3//f/+//7//v/+//7//v/+//7//v/9//7//f/+//7//v/9//7//v/+//7//f/+//7//v/9//7//v/+//7//v/+//7//v/+//7//v/9/////v/+//7//f/+//7//v/9//7//v/+//3//v/+//7///////7//v/+//7/AAABAP//AAD//wAAAQAAAAAAAAAAAAAAAAABAAEA//8AAAAAAAAAAAAA/v8AAAAAAQAAAAAA//8AAAAAAAD//wEAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAD//wAAAAABAP//AAAAAP////8AAAAAAQAAAAAAAAAAAAAAAAAAAAAAAQD//wAAAAAAAAAA//8BAAAAAQABAAAAAAAAAAAAAAABAAAA//8AAAAAAAAAAAAA//8AAAAAAQABAP//AAAAAP//AAAAAAEAAAABAAAAAAAAAAAAAAAAAP//AAD//wAAAAAAAAAAAAAAAAAAAAAAAAAA////////AAACAAEAAAAAAAAA//8BAP//AAD//wEAAQAAAAEAAAAAAAIAAAAAAAAAAQAAAAEAAAABAP//AAAAAAAAAAAAAP//AAAAAAAAAAAAAAAAAAACAAAAAAAAAAEAAAAAAP7///8AAAEA//8AAP7/AAAAAAAAAQD/////AAD///////8AAAAAAAD//wAAAAAAAAEAAAABAP//AAABAAAA//8AAAAAAAABAP//AAABAAAAAQAAAAAAAQABAP//AAABAAAAAQAAAAAAAQABAAAAAAAAAAAA//8AAAEA//8BAAAA//8AAAAAAAAAAAAA//8BAAAAAAAAAAAAAAABAP///////wAAAAABAAAAAAAAAAAAAAAAAAIAAQAAAAEA//8CAAAAAAD//wAAAAAAAP//AAD//////////wAAAAAAAAEAAAABAAAAAAAAAAAA//8AAAAA/v8AAAEAAAABAAEA/////wAAAAAAAAAAAAD//wAAAAABAP//AQAAAAAAAAAAAAAAAQAAAAEAAAD//wAAAAAAAAAA//8AAP//AQABAP////8AAAAAAAABAAAAAQAAAAAAAAAAAP//AAD//wEAAAAAAAAAAAABAAAAAAAAAP//AAAAAAAAAAAAAAAAAAAAAP////8AAP////8AAAAA/////wAA//8BAAAAAAD//wAA//8AAAEA//8AAAAAAQAAAAEAAQAAAP//AAAAAAAAAAAAAAAA//8AAAAAAAABAAAAAAABAAEA/v8AAAAAAAAAAAAAAQAAAP//AAD//wIAAAAAAAAAAAABAAEAAAAAAAAA/v8AAAAAAAD//wEAAQD//wAAAAAAAAAAAAAAAAAAAAAAAP////8AAP//AAABAAAAAAABAAEAAAABAAAAAAAAAAAAAAD//wAAAQABAAAAAAD/////AAD//wEAAQABAAAAAAD//wAAAQAAAAAAAQD/////AQAAAAAA//8AAAIAAAAAAP//AAABAAAAAAABAAAAAAABAP//AAD//wAAAAAAAAAAAAAAAAEAAAAAAP//////////AAAAAAEAAAD//wAAAQAAAP//AQAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAA//8AAP/////+/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wAAAAAAAAAAAQABAAEA/////wAA//8AAAAAAQAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAD//wAAAQAAAAAAAAAAAAAAAQABAP//AQD//wAAAAD//wEAAAD/////AAAAAAAA//8AAAAAAAD//wAA//8AAAAAAAAAAAAAAAABAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAP//AAABAAEAAAAAAAAAAAAAAP//AQAAAP///////wAAAAD+/wAAAQAAAAEAAQAAAAAA//8AAAEAAAAAAP//AAAAAAAAAAAAAAAAAAAAAP//AQABAAAAAAAAAAAAAQAAAAAAAAD///////8AAAAAAAD+/wEAAAAAAAEA//8BAAAA//8AAAAAAAAAAAAAAAABAAAA//8AAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAgABAAEAAAD//wAAAQD+/wAAAAAAAP//AAAAAAAAAAD//wEAAQABAAEAAAAAAAAA/v8AAP//AAAAAAEAAAD/////AAABAP//AAAAAAAAAAAAAAEAAAAAAP//AQAAAAAAAAAAAAAAAAD//wEAAAAAAAEA//8BAAAAAAAAAP//AAAAAAAAAAAAAAAAAAD///////8AAAEA//8AAP//AAAAAP//AQAAAAAAAQAAAAAAAQAAAP//AAAAAAAA/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAP//AAAAAP//AAAAAAEAAQAAAAAAAAABAAEA//8AAAEAAAD//wEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAD//wEAAQAAAAAAAAAAAAAAAAAAAP7/AQD//wAAAAD//wAA//8CAAEAAAAAAAEAAAAAAAAAAQABAAAAAAAAAAAAAAAAAAAAAAD/////AAAAAAAA//8AAAAAAAABAP//AAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAEAAQABAAAAAQD//wAA//8BAAEAAAAAAAEA//8BAAAA/v///wEAAAABAAAAAAAAAAAAAQAAAAAAAQD//wEA//8AAAAAAAD//wAA//8AAAAAAAAAAAAA//8AAAAAAAAAAAEA//8AAP//AQAAAAEAAAAAAAAAAAD+/wAAAAABAP//AAAAAAEA/v8BAAAAAAD//wEAAAABAP//AAAAAAAAAAAAAP7/AAD//wEA//8AAP//AQD//wEAAAD/////AQAAAAEA//8BAAAAAQAAAAEA//8BAP//AQAAAAEA//8BAP//AQD//wAAAAABAP//AgD//wAA//8BAP//AAD//wEA/v8CAP//AgD+/wIA/f8BAP7/AQD9/wEAAAAAAP7/AgD+/wAA/v8CAP7/AgD+/wEA/v8CAP7/AgD+/wIA/v8CAP//AgD+/wIA/v8DAP3/AwD+/wMA/f8DAP7/AwD8/wIA/v8BAPz/AwD9/wIA/f8DAPz/AwD9/wUA/P8EAP3/BAD8/wQA/f8EAPz/BQD7/wMA+/8EAPv/BQD8/wUA+/8FAPv/BQD7/wUA+/8FAPv/BQD6/wUA+/8FAPr/BwD6/wYA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bP5v/nn+e/6F/oj+j/6T/pz+n/6m/qn+sf60/rv+v/7E/sf+z/7S/tn+2/7h/uX+7P7t/vP+9f79/v7+A/8F/wv/Df8S/xX/Gf8a/yL/JP8p/yr/MP8v/zT/N/86/z7/Qf9D/0f/Sf9N/03/U/9V/1j/Wf9c/17/Yf9j/2f/aP9r/23/cP9x/3L/d/94/3r/fv9+/4L/gv+F/4b/if+K/4z/jf+Q/5H/lP+U/5f/l/+a/5r/nf+f/6D/of+j/6T/pf+m/6n/q/+r/6z/rP+v/7D/sv+z/7P/tf+2/7n/uP+5/7r/u/+7/77/v//A/8D/wv/D/8L/xP/F/8b/xv/J/8j/y//L/8z/zP/N/87/z//O/9D/0P/S/9L/0//T/9T/1f/X/9b/1//Y/9j/2v/a/9r/2v/a/9v/3f/a/97/3v/d/97/4P/f/+D/4P/h/+L/4//i/+P/5P/j/+P/5P/l/+b/5//n/+b/5//o/+n/5//p/+j/6f/r/+r/6v/q/+r/6//r/+z/7P/t/+v/7f/u/+7/7v/u/+7/7f/u/+7/8P/w//D/8P/w//D/7//w//P/8v/y//P/8v/y//L/8//y//P/9P/0//X/9P/0//L/9P/z//T/9P/0//X/9f/2//f/9f/2//f/9v/2//b/9v/2//b/9v/2//n/+P/4//j/+P/4//j/+P/3//j/+P/5//j/9//5//n/+P/4//r/+v/6//r/+v/5//v/+v/7//n/+v/6//r/+//6//v/+f/6//n/+v/6//r/+v/6//r/+v/8//z//P/8//3//P/9//z//f/8//z//P/8//z//P/8//z//P/8//z//P/8//z/+//9//z/+//7//v//P/8//v//P/9//3//P/7//3//f/7//3//P/8//3//f/+//7//f/+//7//v/+/////v/+//3//v/+//3//f/+//7//v/+//7//f/+//7////+/////v/+//7//v/+//7//v/+//7//v////3//v/+//7//v/+/////f/+/////v/9//7//v/+//7//v/+/////v/+//7//v/9//7//f/+//3////+//7//f/+//7//v////7//v////3//v/+/////v/+//7//f/+/////f/+//7//v/+//7//v/+//3//f/+//3//v/9//3//v/+//3//v///////v/+//7////+/////v/+///////+//7//v/+//3//v/+//7//v/+//3//v/+//7////+//3//v/9//3///////7//v///////v///////v/8/////v8AAP///v/+//7//v///////////////f/+//7////+/////v/9//3//v////7//v////7//P/9//7//v/+//3//v/+//7//v////7//f/+//7//v/+//7//v////7///////7//v/+//3//f/+//7//v/8//3//f/+//7//v/+//7//v/+//7//v/+//3//f/+//7//v////3//f/9/////v/9//3////+//////////7//v////7//v/+//3////+//3//f/9//7//v////z//v/+//7////9//7//v/+//3//v////7//v/+//3//v/+//7//v////3//v/+//7//v////7//v/+//7////9//7//f////7//f/+//7//v/+//7//v/+//7//v/+//7//v/9//7//v/+/////v/+//7//v/+//7////+//7//v/+//7//v////7////+//7//v/+//7////9//3//v/+//7//v////7////+//7//v/+/////f////7//v/+//7///8AAP7//v/+//7//v/+//7//f/+/////v////7//v/+//7//f/+//7//v/+//7////+//7//v////7//v/+/////v/9//3//v/9//z/AAAAAP//AQABAAAAAAD//wAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAA//8AAP//AAABAAAAAAAAAP//AQAAAAAAAAAAAAAAAQABAAAAAQAAAAEA//8AAAEAAAABAAAAAAAAAAAAAAD//wAAAQAAAAEAAQABAAAAAQD//wEAAAAAAAAA//8AAAAAAQAAAAAAAAABAAAAAAAAAAAA//8AAAEAAAD//wEAAAAAAAIAAQAAAAAA//8AAAAA//8AAAAAAAABAAAA//8BAAAAAAAAAAEAAQAAAP//AAAAAP//AAAAAAAAAgAAAP//AQD//wAAAAD//wAAAAAAAAAAAAAAAAAAAQAAAAEA//8AAAAAAAAAAAEA/////wAA/v/+////AAABAAAAAQABAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAD//wAAAAD//wAA//8BAAAAAQABAAAAAAABAAAAAQABAAAA//8AAAAA//8AAP//AAAAAAAA/v///wIA//8AAAAAAAD/////AQAAAAAAAAAAAAEAAQD+/wEAAQAAAAAA//8AAP////8AAAAAAAAAAP//AAAAAAAAAAD/////AAAAAAAAAAD//wAA//8AAAAAAAAAAAAAAAD//wAAAAAAAAAAAAACAP//AAD+/wAAAQAAAP//AAD//wAA////////AAABAAAAAAAAAAAAAAD//wEAAAABAAAAAAABAAAAAQABAAAAAAABAAAA//8CAAAA/v///wAAAAAAAP//AQD//wAAAAAAAAEAAgABAAEAAAD/////AAAAAAAAAAD//wEAAAAAAP//AQAAAP////8AAP////8CAAAA/////wAAAAD/////AQAAAAAAAAAAAP//AAAAAAAAAAAAAAEAAAAAAAEAAAABAAAAAQD//wAAAAAAAP//AQAAAAEAAAD//wAAAAABAAAAAAD//wAAAAD//wAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAAAABAExJU1QqAAAASU5GT0lDTVQeAAAAaHR0cDovL3RoZW11c2hyb29ta2luZ2RvbS5uZXQAU3lMcLAAAAABAAAAAAAAAAAAAAAAAPA/EwJyfiohU0AAAAAAAAAAAAAAAAAAAAAAikMAAAEAAAAAAAAAAADwPwEAAAAAAAAAAAAAAADAVUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAnJ+KiFTQAAAAAACAAAAAAAAAAAAQEAAAAAAAAA5QAEAAAAAAAAAAAAAAAAAJEAAAAAAAAAiQAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAGJleHRbAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyMDEwLTAyLTEwMjI6MDQ6MDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHNtcGw8AAAAAAAAAAAAAAAnsQAAQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        sound.volume = 1;
        sound.play();
    }
})(unsafeWindow);