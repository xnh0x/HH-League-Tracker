// ==UserScript==
// @name         HH League Tracker
// @version      1.2
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
// @run-at       document-end
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

    const config = await loadConfig();

    info('config:', config);

    if(window.location.pathname !== '/leagues.html') {
        return;
    }

    const NUMBER_FORMATTER = Intl.NumberFormat('en', { notation: 'compact', signDisplay: "exceptZero" }).format;
    const PERCENT_FORMATTER = Intl.NumberFormat('en', { minimumFractionDigits : 1, maximumFractionDigits : 1, signDisplay: "exceptZero" }).format;

    // for object comparison
    const isEqual = (await import('https://esm.sh/lodash/isEqual')).default;

    // GitHub API
    const { Octokit } = await import('https://esm.sh/@octokit/rest');
    let OCTOKIT, GITHUB_CONFIG;

    const LOCAL_STORAGE_KEYS = {
        scores: 'HHLeagueTrackerScoreData',
        stats: 'HHLeagueTrackerStatData',
        leagueEnd: 'HHLeagueTrackerLeagueEnd'
    }

    const LEAGUE_END_TS = (window.server_now_ts + window.season_end_at) * 1000;
    const OPPONENTS_BY_ID = opponents_list.reduce(function(map,object) { map[object.player.id_fighter] = object; return map; }, {})

    if (config.githubStorage.enabled) {
        if (!window.LeagueTrackerGitHubConfig) {
            info('GitHubConfig missing, using localStorage')
            config.githubStorage.enabled = false;
        } else {
            GITHUB_CONFIG = window.LeagueTrackerGitHubConfig;
            const PLATFORM = shared.Hero.infos.hh_universe;
            // week and minimum id of all players uniquely identify a league bracket
            const LEAGUE_ID = opponents_list.reduce((a,b) => a.player.id_fighter < b.player.id_fighter ? a : b).player.id_fighter;
            const WEEK = getWeekName(LEAGUE_END_TS);
            GITHUB_CONFIG.path = PLATFORM + '/' + WEEK + '/' + LEAGUE_ID + '_scores.json';
            OCTOKIT = new Octokit({
                auth: GITHUB_CONFIG.token,
            });
        }
    }

    await leagueTracker(true);

    async function leagueTracker(firstRun) {
        if (document.querySelector('#leagues div.league_girl') === null) {
            setTimeout(leagueTracker, 5, firstRun);
            return;
        }

        // load local data in case the read from GitHub fails
        let oldOpponentScores = {
            data: JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.scores)) || {},
        };

        if (config.githubStorage.enabled) {
            try {
                oldOpponentScores = await readFromGithub();
            } catch (e) {
                if (firstRun && e.status === 404) {
                    info(GITHUB_CONFIG.path + ' doesn\'t exist yet')
                    try {
                        await commitNewFile();
                    } catch (f) {
                        info(f);
                    }
                    info('restart script');
                    setTimeout(leagueTracker, 500, false);
                    return;
                } else if (e.status === 401) {
                    info('check github config, token not valid for repo, using localStorage')
                } else {
                    info('couldn\'t read data from github, using localStorage');
                }
                config.githubStorage.enabled = false;
            }
        }

        let oldOpponentStats = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.stats)) || {};

        // check and reset local storage for new league
        const STORED_LEAGUE_END_TS = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.leagueEnd)) || Infinity;
        if (STORED_LEAGUE_END_TS < LEAGUE_END_TS) {
            info('new league has started, deleting old data from local storage')
            if (!config.githubStorage.enabled) {
                oldOpponentScores = { data: {} };
            }
            oldOpponentStats = {};
        }

        let newOpponentScores = {};
        let newOpponentStats = {};

        function updateTable() {
            let opponentRows = document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row');
            for (let i = 0; i < opponentRows.length; i++) {
                const opponentRow = opponentRows[i];
                const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                newOpponentScores[id] = updateScore(opponentRow, id, oldOpponentScores.data[id] || {});
                newOpponentStats[id] = updateStats(opponentRow, id, oldOpponentStats[id] || {});
                if (config.activeSkill.enabled) {
                    markActiveSkill(opponentRow, id);
                }
            }
        }

        updateTable();
        // redo changes after sorting the table
        $(document).on('league:table-sorted', () => { updateTable(); })

        localStorage.setItem(LOCAL_STORAGE_KEYS.scores, JSON.stringify(newOpponentScores));
        if (config.githubStorage.enabled) {
            // write score data to GitHub
            await commitUpdate(oldOpponentScores.data, oldOpponentScores.sha, newOpponentScores);
        }
        // stat changes don't really need to be shared between devices so local storage is sufficient
        localStorage.setItem(LOCAL_STORAGE_KEYS.stats, JSON.stringify(newOpponentStats));
        // remember new league end
        localStorage.setItem(LOCAL_STORAGE_KEYS.leagueEnd, JSON.stringify(LEAGUE_END_TS));
    }

    function info() {
        log('', arguments);
    }

    function log(tag, args) {
        let _args = ['League Tracker:' + tag];
        // _args.push('League Tracker:' + tag);
        for( let i = 0; i < args.length; i++ ) {
            _args.push( args[i] );
        }
        console.log.apply( console, _args );
    }

    function updateScore(opponentRow, id, oldData)
    {
        const opponent = OPPONENTS_BY_ID[id];
        const nickname = encodeURI(opponent.nickname);
        const score = opponent.player_league_points;

        const oldScore = oldData.score || 0;
        const oldLostPoints = oldData.totalLostPoints || 0;
        let lastDiff = oldData.lastDiff || 0;
        let lastLostPoints = oldData.lastLostPoints || 0;
        let lastChangeTime = oldData.lastChangeTime || 0;

        const gainedScore = score - oldScore;
        const newLostPoints = 25 - (((gainedScore + 24) % 25) + 1);
        const totalLostPoints = oldLostPoints + newLostPoints;

        // add lost points below score
        opponentRow.querySelector('.data-column[column="player_league_points"]').innerHTML += '<br>' + (-totalLostPoints);

        if (config.scoreColor.enabled) {
            const scoreColor = getScoreColor(totalLostPoints)
            if (config.scoreColor.rank) {
                opponentRow.querySelector('.data-column[column="place"]').style.color = scoreColor;
            }
            if (config.scoreColor.name) {
                // remove clubmate class from League++ so clubmates get colored correctly too
                opponentRow.querySelector('.data-column[column="nickname"]').classList.remove("clubmate");
                opponentRow.querySelector('.data-column[column="nickname"]').style.color = scoreColor;
            }
            if (config.scoreColor.level) {
                opponentRow.querySelector('.data-column[column="level"]').style.color = scoreColor;
            }
            if (config.scoreColor.points) {
                opponentRow.querySelector('.data-column[column="player_league_points"]').style.color = scoreColor;
            }
        }

        // shadow to make text more readable on some games
        opponentRow.querySelector('.data-column[column="place"]').style.textShadow = "1px 1px 0px #000000";
        opponentRow.querySelector('.data-column[column="nickname"]').style.textShadow = "1px 1px 0px #000000";
        opponentRow.querySelector('.data-column[column="level"]').style.textShadow = "1px 1px 0px #000000";
        opponentRow.querySelector('.data-column[column="power"]').style.textShadow = "1px 1px 0px #000000";
        opponentRow.querySelector('.data-column[column="player_league_points"]').style.textShadow = "1px 1px 0px #000000";
        opponentRow.querySelector('.data-column[column="team"]').style.textShadow = "1px 1px 0px #000000";

        opponentRow.querySelector('.data-column[column="player_league_points"]').style.textAlign = "right";
        opponentRow.querySelector('.data-column[column="player_league_points"]').style.lineHeight = "15px";

        if (gainedScore > 0) {
            lastDiff = gainedScore;
            lastLostPoints = newLostPoints;
            lastChangeTime = Date.now();
            opponentRow.querySelector('.data-column[column="player_league_points"]').style.color = "#16ffc4";
            opponentRow.querySelector('.data-column[column="player_league_points"]').innerHTML = '+' + lastDiff + '<br>' + (-lastLostPoints);
            opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute(
                'tooltip', 'Total Score: ' + score + '<br>Total Lost Points: ' + (-totalLostPoints));
        } else if (lastDiff > 0) {
            if (lastChangeTime > 0) {
                const timeDiff = formatTime(Date.now() - lastChangeTime);
                opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute(
                    'tooltip', 'Last Score Diff: ' + lastDiff +
                    '<br>Last Lost Points: ' + lastLostPoints +
                    '<br>' + timeDiff + ' ago');
            } else {
                opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute(
                    'tooltip', 'Last Score Diff: ' + lastDiff +
                    '<br>Last Lost Points: ' + lastLostPoints);
            }
        }
        return {nickname, score, totalLostPoints, lastDiff, lastLostPoints, lastChangeTime};
    }

    function updateStats(opponentRow, id, oldData)
    {
        const STAT_ELEMENT_MAP = {
            'damage': {'div':'#player_attack_stat', 'span':'#stats-damage'},
            'remaining_ego': {'div':'#player_ego_stat', 'span':'#stats-ego'},
            'defense': {'div':'#player_defence_stat', 'span':'#stats-defense'},
            'chance': {'div':'#player_harmony_stat', 'span':'#stats-chance'}
        };
        const opponent = OPPONENTS_BY_ID[id];

        let newStats = {};
        for (const stat in STAT_ELEMENT_MAP) {
            const value = opponent.player[stat];
            const oldValue = oldData[stat]?.value || 0;
            let lastDiff = oldData[stat]?.lastDiff || 0;
            let lastChangeTime = oldData[stat]?.lastChangeTime || 0;

            const statDiff = value - oldValue;
            const percentage = value > 0 ? ((100 * statDiff) / value).toFixed(1) : 0;
            const lastPercentage = oldValue > 0 ? ((100 * lastDiff) / oldValue).toFixed(1) : 0;

            // shadow to make text more readable on some games
            opponentRow.querySelector(STAT_ELEMENT_MAP[stat].span).style.textShadow = "1px 1px 0px #000000";

            if (statDiff**2 > 1e4) { // ignore small changes
                opponentRow.querySelector(STAT_ELEMENT_MAP[stat].span).style.color =
                    (lastChangeTime > 0) ? ((statDiff > 0) ? "#ec0039" : "#32bc4f") : "#ffffff";
                lastDiff = statDiff;
                lastChangeTime = (oldValue > 0) ? Date.now() : 0;
                opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute(
                    'tooltip', 'Stat Diff: ' + NUMBER_FORMATTER(lastDiff) +
                    ' (' + PERCENT_FORMATTER(percentage) + '%)');
            } else if (lastChangeTime > 0) {
                const timeDiff = Date.now() - lastChangeTime;
                const statColor = (timeDiff < 60 * 1000) ?
                    ((lastDiff > 0) ? "#ec0039" : "#32bc4f") :
                    ((lastDiff > 0) ? "#ff8aa6" : "#a4e7b2"); // lighter highlight color for changes older than 1 minute
                if (timeDiff < 10 * 60 * 1000) { // only highlight changes in the last 10 minutes
                    opponentRow.querySelector(STAT_ELEMENT_MAP[stat].span).style.color = statColor;
                }
                opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute(
                    'tooltip', 'Last Stat Diff: ' + NUMBER_FORMATTER(lastDiff) +
                    ' (' + PERCENT_FORMATTER(lastPercentage) + '%)' +
                    '<br>' + formatTime(timeDiff) + ' ago');
            }
            newStats[stat] = {value, lastDiff, lastChangeTime};
        }
        return newStats;
    }

    function markActiveSkill(opponentRow, id) {
        const center = OPPONENTS_BY_ID[id].player.team.girls[0];

        if (center.skill_tiers_info['5']?.skill_points_used) {
            const {type, id, color} = getSkillByElement(center.girl.element, config.activeSkill.ocd);

            if (config.activeSkill.noIcon) {
                applySkillColor(opponentRow.querySelector('.data-column[column="nickname"]'), color);
            } else {
                addSkillIcon(opponentRow.querySelector('.data-column[column="team"]').firstElementChild,
                    type, id, center.skills[id].skill.display_value_text);
            }

        }
    }

    function applySkillColor(nickname, color) {
        // remove clubmate class from League++ so clubmates get colored correctly too
        nickname.classList.remove("clubmate");
        nickname.style.color = color;
    }

    function addSkillIcon(team_icons, type, id, tooltip) {
        // move the icons a little closer together
        team_icons.lastElementChild.style.marginRight = '-0.1rem';
        if (team_icons.childElementCount === 2) {
            // this will overlap the two theme elements to save space
            team_icons.lastElementChild.style.marginLeft = '-0.66rem';
        }

        let skill_icon = document.createElement('img');
        skill_icon.classList.add('team-theme', 'icon');
        skill_icon.src = getSkillIcon(type);
        skill_icon.setAttribute('tooltip', tooltip);

        team_icons.appendChild(skill_icon);
    }

    function getScoreColor(lostPoints)
    {
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

    function getSkillByElement(element, ocd) {
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
                throw 'Unknown element: ' + element;
        }
    }

    function getSkillIcon(type) {
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
                throw 'Unknown skill type: ' + type;
        }
    }

    function formatTime(millis)
    {
        let seconds = Math.floor(millis / 1000);
        let minutes = Math.floor(seconds / 60);
        let hours = Math.floor(minutes / 60);
        let days = Math.floor(hours / 24);
        seconds %= 60;
        minutes %= 60;
        hours %= 24;
        return (days > 0 ? days + 'd ' : '') +
            (days > 0 || hours > 0 ? hours + 'h ' : '') +
            (days > 0 || hours > 0 || minutes > 0 ? minutes + 'm ' : '') +
            seconds + 's';
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

    async function readFromGithub() {
        info('reading ' + GITHUB_CONFIG.path);
        const params = {
            owner: GITHUB_CONFIG.owner,
            repo: GITHUB_CONFIG.repo,
            path: GITHUB_CONFIG.path,
            headers: {
                'If-None-Match': '' // workaround for avoiding cached data
            },
        }
        const response = await OCTOKIT.rest.repos.getContent(params);
        return {
            data: JSON.parse(atob(response.data.content)), // file content needs to be decoded from base64
            sha: response.data.sha, // required to write an update later
        };
    }

    function commitMessage(action) {
        return (new Date()).toISOString() + ' [' + shared.Hero.infos.name + '] ' + action + ' ' + GITHUB_CONFIG.path;
    }

    async function commitNewFile() {
        info('creating ' + GITHUB_CONFIG.path);
        const message = commitMessage('create');
        const content = btoa('{}'); // needs to be encoded in base64
        await writeToGithub(content, message);
    }

    async function commitUpdate(oldData, sha, data) {
        if (isEqual(oldData, data)) {
            info('nothing changed, no need to update');
            return;
        }
        info('updating ' + GITHUB_CONFIG.path);
        const message = commitMessage('update');
        const content = btoa(JSON.stringify(data, null, 2)); // needs to be encoded in base64
        await writeToGithub(content, message, sha);
    }

    async function writeToGithub(content, message, sha = null) {
        let params = {
            owner: GITHUB_CONFIG.owner,
            repo: GITHUB_CONFIG.repo,
            path: GITHUB_CONFIG.path,
            message: message,
            content: content,
        }
        if (sha) {
            params.sha = sha // to write an update sha is required
        }
        OCTOKIT.rest.repos.createOrUpdateFileContents(params);
    }

    function getHHPlusPlusConfig() {
        return (async () => {
            await new Promise($);
            return window.hhPlusPlusConfig;
        })();
    }

    async function loadConfig()
    {
        // defaults
        let config = {
            githubStorage: {
                enabled: false,
            },
            scoreColor: {
                enabled: true,
                rank: false,
                name: false,
                level: false,
                points: true,
            },
            activeSkill: {
                enabled: false,
                noIcon: false,
                ocd: false,
            }
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
                default: false,
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
                label: 'Color players based on the amount of lost points',
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
                default: false,
                subSettings: [
                    { key: 'noIcon', default: false, label: 'Instead of an icon apply color to the name' },
                    { key: 'ocd', default: false, label: 'Use the same colors as OCD' },
                ],
            },
            run(subSettings) {
                config.activeSkill = {
                    enabled: true,
                    noIcon: subSettings.noIcon,
                    ocd: subSettings.ocd,
                };
                config.scoreColor.name &= !subSettings.noIcon;
            },
        });
        config.activeSkill.enabled = false;

        hhPlusPlusConfig.loadConfig();
        hhPlusPlusConfig.runModules();

        return config;
    }
})(unsafeWindow);