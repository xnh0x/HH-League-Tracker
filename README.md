# HH-League-Tracker

![HH_League_Tracker](https://github.com/user-attachments/assets/84114d70-9528-4036-a0d0-057d3a7ea4de)

## Install

Install from here https://github.com/xnh0x/HH-League-Tracker/raw/refs/heads/master/HHLeagueTracker.user.js

On PC you need [TamperMonkey](https://www.tampermonkey.net) or a similar browser extension.

Tested on iOS Safari with the [Stay](https://apps.apple.com/us/app/stay-for-safari/id1591620171) userscript manager.

Requires [HH++ BDSM](https://github.com/zoop0kemon/hh-plus-plus) for the configuration.

## Features

### Score Tracking
Keeps counting everyones lost points and colors them based on the total amount lost. Optionally uses GitHub to sync data between devices.

![Score_Tracking](https://github.com/user-attachments/assets/a2464dda-f733-4e17-a19a-8b53db8c8639)

### Stat Tracking
Highlights stat changes.

![Stat_Tracking](https://github.com/user-attachments/assets/13ed9fb5-16c1-4bd9-b2ca-27ca82640a6f)

### Skill Icons (requires HH++ BDSM)
Adds icons for the active skill to the team column. Optionally colors the player names instead like OCD does.

![Skill_Icons](https://github.com/user-attachments/assets/e1b10349-4d2f-4b60-81c6-23e21e0afb70)

### Used Teams (requires HH++ BDSM)
Keeps a list of teams the opponents have used this week.

![Used_teams](https://github.com/user-attachments/assets/8cab496d-5dce-4631-bcb2-94074cb69d89)

## Setup GitHub Sync

### Prepare Repo

- Create a new repo e.g. "League-Tracker-Storage". You can set visibility to private.
- Go to https://github.com/settings/tokens?type=beta and click generate a new token. This will be used by the script to read and write the data.
- Give it a name, choose and expiry date and under "Repository access" pick "Only select repositories" and choose only the new repo you created:

  ![new_token](https://github.com/user-attachments/assets/68e64c58-48fb-40ca-8235-374c70455917)

- Then under "Permissions" give it read and write access for "Contents":

  ![permissions](https://github.com/user-attachments/assets/5db16272-415e-450e-a20a-9216d216e1bd)

- Click Generate at the bottom of the page

The token will be something like `github_pat_abcde12345_fghij67890`. Save the token somewhere you won't be able to see it again later. Once the token expires you'll need to create a new one.

### Provide the repo information to the tracker script

Install the second script https://github.com/xnh0x/HH-League-Tracker/raw/refs/heads/master/HHLeagueTrackerGitHubConfig.user.js and fill in your GitHub username, the name of the storage repo and the access token you just created like this and save it:
```
(function () {
    window.LeagueTrackerGitHubConfig = {
        owner: 'xnh0x',
        repo: 'League-Tracker-Storage',
        token: 'github_pat_abcde12345_fghij67890',
    };
})()
```

### Enable the sync

The sync is on by default. To turn it off you can either simply turn off or remove the GitHub config script mentioned above so the Tracker script can't use GitHub or if you have HH++ you can just go to the "League Tracker" tab in the options menu there and deactivate the sync option.
