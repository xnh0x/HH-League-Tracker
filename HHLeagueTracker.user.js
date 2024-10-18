// ==UserScript==
// @name         HH League Tracker
// @version      1.4.2
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

    const config = await loadConfig();

    info('config:', config);

    if(window.location.pathname !== '/leagues.html') {
        return;
    }

    addCSS();

    const NUMBER_FORMATTER = Intl.NumberFormat('en', { notation: 'compact', signDisplay: "exceptZero" }).format;
    const PERCENT_FORMATTER = Intl.NumberFormat('en', { minimumFractionDigits : 1, maximumFractionDigits : 1, signDisplay: "exceptZero" }).format;

    // for object comparison
    const isEqual = (await import('https://esm.sh/lodash/isEqual')).default;

    // GitHub API
    const { Octokit } = await import('https://esm.sh/@octokit/rest');
    let OCTOKIT, GITHUB_CONFIG;

    const LOCAL_STORAGE_KEYS = {
        data: 'HHLeagueTrackerData',
        scores: 'HHLeagueTrackerScoreData', // XXX remove in 1.5
        stats: 'HHLeagueTrackerStatData',
        teams: 'HHLeagueTrackerTeamData', // XXX remove in 1.5
        leagueEnd: 'HHLeagueTrackerLeagueEnd'
    }

    const LEAGUE_END_TS = (window.server_now_ts + window.season_end_at) * 1000;

    if (!opponents_list.length) {
        info('no opponents found');
        return;
    }
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
            GITHUB_CONFIG.path = `${PLATFORM}/${WEEK}/${LEAGUE_ID}_scores.json`;
            OCTOKIT = new Octokit({
                auth: GITHUB_CONFIG.token,
            });
        }
    }

    // check if a new league started and reset local storage and
    const STORED_LEAGUE_END_TS = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.leagueEnd)) || Infinity;
    localStorage.setItem(LOCAL_STORAGE_KEYS.leagueEnd, JSON.stringify(LEAGUE_END_TS));
    if (STORED_LEAGUE_END_TS < LEAGUE_END_TS) {
        info('new league has started, deleting old data from local storage')
        localStorage.removeItem(LOCAL_STORAGE_KEYS.data);
        localStorage.removeItem(LOCAL_STORAGE_KEYS.scores); // XXX remove in 1.5
        localStorage.removeItem(LOCAL_STORAGE_KEYS.teams); // XXX remove in 1.5
        localStorage.removeItem(LOCAL_STORAGE_KEYS.stats);
        if (config.githubStorage.enabled) {
            await commitNewFile();
            // give GitHub a moment to process the new file
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    await leagueTracker(true);

    async function leagueTracker(firstRun) {
        let localStorageData = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.data))
            || JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.scores)) // XXX remove in 1.5
            || {};

        let oldOpponentData = { data: {} };
        if (config.githubStorage.enabled) {
            try {
                oldOpponentData = await readFromGithub();
                // merge local storage data into the data from GitHub to not lose data if sync was previously off or
                // temporarily unavailable
                if (!isEqual(localStorageData, oldOpponentData.data)) {
                    for (const [id, scores] of Object.entries(localStorageData)) {
                        if (!oldOpponentData.data[id] || oldOpponentData.data[id].lastChangeTime < scores.lastChangeTime) {
                            oldOpponentData.data[id] = scores;
                        }
                    }
                }
            } catch (e) {
                if (firstRun && e.status === 404) {
                    info(`${GITHUB_CONFIG.path} doesn't exist yet`)
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

        // use local data in case the read from GitHub failed
        if (!oldOpponentData.data.length) { oldOpponentData.data = localStorageData; }

        let newOpponentData = structuredClone(oldOpponentData.data);
        let newOpponentStats = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.stats)) || {};

        function updateTable() {
            document.querySelectorAll('#leagues .league_table .data-list .data-row.body-row').forEach(
                opponentRow => {
                    const id = parseInt(opponentRow.querySelector('.data-column[column="nickname"] .nickname').getAttribute('id-member'));

                    newOpponentData[id] = updateScore(opponentRow, id, newOpponentData[id] || {});
                    newOpponentStats[id] = updateStats(opponentRow, id, newOpponentStats[id] || {});
                    if (config.activeSkill.enabled) {
                        markActiveSkill(opponentRow, id);
                    }
                    // no need to collect your own teams
                    if (config.usedTeams.enabled && id !== shared.Hero.infos.id) {
                        newOpponentData[id] = updateUsedTeams(opponentRow, id, newOpponentData[id] || {});
                    }
                }
            )
        }

        updateTable();
        // redo changes after sorting the table
        $(document).on('league:table-sorted', () => { updateTable(); })

        localStorage.setItem(LOCAL_STORAGE_KEYS.scores, JSON.stringify(newOpponentData));
        if (config.githubStorage.enabled) {
            // write score data to GitHub
            await commitUpdate(oldOpponentData.data, oldOpponentData.sha, newOpponentData);
        }
        // stat changes don't really need to be shared between devices so local storage is sufficient
        localStorage.setItem(LOCAL_STORAGE_KEYS.stats, JSON.stringify(newOpponentStats));
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
            // reduce line height to fit two lines of text in the row
            '.data-column[column="player_league_points"] { text-align: right; line-height: 15px; }',
        ].join(' ');
        document.head.appendChild(sheet);
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
        opponentRow.querySelector('.data-column[column="player_league_points"]').innerHTML += `<br>${-totalLostPoints}`;

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

        if (gainedScore > 0) {
            lastDiff = gainedScore;
            lastLostPoints = newLostPoints;
            lastChangeTime = Date.now();
            opponentRow.querySelector('.data-column[column="player_league_points"]').style.color = "#16ffc4";
            opponentRow.querySelector('.data-column[column="player_league_points"]').innerHTML = `+${lastDiff}<br>${-lastLostPoints}`;
            opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute('tooltip',
                `Total Score: ${score}<br>Total Lost Points: -${totalLostPoints}`);
        } else if (lastDiff > 0) {
            if (lastChangeTime > 0) {
                const timeDiff = formatTime(Date.now() - lastChangeTime);
                opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute('tooltip',
                    `Last Score Diff: ${lastDiff}` +
                    `<br>Last Lost Points: ${lastLostPoints}` +
                    `<br>${timeDiff} ago`);
            } else {
                opponentRow.querySelector('.data-column[column="player_league_points"]').setAttribute('tooltip',
                    `Last Score Diff: ${lastDiff}` +
                    `<br>Last Lost Points: ${lastLostPoints}`);
            }
        }
        return {...oldData, nickname, score, totalLostPoints, lastDiff, lastLostPoints, lastChangeTime};
    }

    function updateStats(opponentRow, id, oldData)
    {
        const STAT_ELEMENT_MAP = {
            'damage': {'div':'#player_attack_stat', 'span':'#stats-damage'},
            'remaining_ego': {'div':'#player_ego_stat', 'span':'#stats-ego'},
            'defense': {'div':'#player_defence_stat', 'span':'#stats-defense'},
            'chance': {'div':'#player_harmony_stat', 'span':'#stats-chance'},
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
                opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute('tooltip',
                    `Stat Diff: ${NUMBER_FORMATTER(lastDiff)} (${PERCENT_FORMATTER(percentage)}%)`);
            } else if (lastChangeTime > 0) {
                const timeDiff = Date.now() - lastChangeTime;
                const statColor = (timeDiff < 60 * 1000) ?
                    ((lastDiff > 0) ? "#ec0039" : "#32bc4f") :
                    ((lastDiff > 0) ? "#ff8aa6" : "#a4e7b2"); // lighter highlight color for changes older than 1 minute
                if (timeDiff < 10 * 60 * 1000) { // only highlight changes in the last 10 minutes
                    opponentRow.querySelector(STAT_ELEMENT_MAP[stat].span).style.color = statColor;
                }
                opponentRow.querySelector(STAT_ELEMENT_MAP[stat].div).setAttribute('tooltip',
                    `Last Stat Diff: ${NUMBER_FORMATTER(lastDiff)} (${PERCENT_FORMATTER(lastPercentage)}%)` +
                    `<br>${formatTime(timeDiff)} ago`);
            }
            newStats[stat] = {value, lastDiff, lastChangeTime};
        }
        return {...oldData, ...newStats};
    }

    function markActiveSkill(opponentRow, id) {
        const center = OPPONENTS_BY_ID[id].player.team.girls[0];

        if (center.skill_tiers_info['5']?.skill_points_used) {
            const {type, id, color} = getSkillByElement(center.girl.element, config.activeSkill.ocd);

            if (config.activeSkill.noIcon) {
                applySkillColor(opponentRow.querySelector('.data-column[column="nickname"]'), color);
            } else {
                const tooltip = `${type} ${center.skills[id].skill.display_value_text}`;
                addSkillIcon(opponentRow.querySelector('.data-column[column="team"]').firstElementChild, type, tooltip);
            }

        }
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

    function updateUsedTeams(opponentRow, id, oldData) {
        let oldTeamsSet = oldData.teams?.length ? new Set(oldData.teams) : new Set();
        const opponentTeam = OPPONENTS_BY_ID[id].player.team;
        let type = opponentTeam.girls[0].skill_tiers_info['5']?.skill_points_used
            ? getSkillByElement(opponentTeam.girls[0].girl.element).type
            : null;
        oldTeamsSet.add(JSON.stringify({ theme: opponentTeam.theme, type: type }));
        const teams= Array.from(oldTeamsSet).sort();

        let tooltip = document.createElement('div');
        tooltip.innerText = 'Used Teams:';
        teams.forEach((t)=>{
            let team = JSON.parse(t);
            let div = document.createElement('div');
            team.theme.split(',').forEach((element)=>{
                let elementIcon = getElementIcon(element);
                elementIcon.style.height = '16px';
                elementIcon.style.width = '16px';
                elementIcon.style.marginRight = '-8px';
                div.appendChild(elementIcon);
            });
            div.lastElementChild.style.marginRight = '0';
            if (team.type && team.type !== 'none') {
                let skillIcon = getSkillIcon(team.type);
                skillIcon.style.height = '16px';
                skillIcon.style.width = '16px';
                div.appendChild(skillIcon);
            }
            tooltip.appendChild(div);
        })

        opponentRow.querySelector('.data-column[column="team"]').lastElementChild.setAttribute('tooltip', tooltip.innerHTML)
        return {...oldData, teams}
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

    function getElementIcon(element) {
        let element_icon = document.createElement('img');
        element_icon.classList.add('team-theme', 'icon');
        element_icon.src = getElementIconSrc(element);
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
        info(`reading ${GITHUB_CONFIG.path}`);
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
        return `${(new Date()).toISOString()} [${shared.Hero.infos.name}] ${action} ${GITHUB_CONFIG.path}`;
    }

    async function commitNewFile() {
        info(`creating ${GITHUB_CONFIG.path}`);
        const message = commitMessage('create');
        const content = btoa('{}'); // needs to be encoded in base64
        await writeToGithub(content, message);
    }

    async function commitUpdate(oldData, sha, data) {
        if (isEqual(oldData, data)) {
            info('nothing changed, no need to update');
            return;
        }
        info(`updating ${GITHUB_CONFIG.path}`);
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
            },
            usedTeams: {
                enabled: false,
            },
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
                label: `Color players based on the amount of lost points<br>`
                    + ` <span style="color: ${getScoreColor(0)}">&le;25</span>`
                    + ` <span style="color: ${getScoreColor(26)}">&le;50</span>`
                    + ` <span style="color: ${getScoreColor(51)}">&le;100</span>`
                    + ` <span style="color: ${getScoreColor(101)}">&le;200</span>`,
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
                baseKey: 'usedTeams',
                label: 'Keep a list of used teams for your opponents (tooltip on team power)',
                default: false,
            },
            run() {
                config.usedTeams = {
                    enabled: true,
                };
            },
        });
        config.usedTeams.enabled = false;

        hhPlusPlusConfig.loadConfig();
        hhPlusPlusConfig.runModules();

        return config;
    }
})(unsafeWindow);