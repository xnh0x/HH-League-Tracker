# HH-League-Tracker

Tracks opponents lost points and highlights stat changes. Can use optionally use GitHub to sync data between devices. You'll need HH++ for the configuration.

## Install

Install from here https://github.com/xnh0x/HH-League-Tracker/raw/refs/heads/master/HHLeagueTracker.user.js

On PC you need [TamperMonkey](https://www.tampermonkey.net) or a similar browser extension.

Tested on iOS Safari with the [Stay](https://apps.apple.com/us/app/stay-for-safari/id1591620171) userscript manager.

## Setup GitHub Sync

### Prepare Repo

- Create a new repo e.g. "League-Tracker-Storage". You can set visibility to private but it doesn't really matter.
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

If you have HH++ you can just go to the "League Tracker" tab and activate the sync option.

If you don't have HH++ you need to edit the default config in the Tracker script near the bottom:
```
        // defaults
        let config = {
            githubStorage: {
                enabled: false,      <-- set this to true
            },
            scoreColor: {
                enabled: true,
                rank: false,
                name: false,
                level: false,
                points: true,
            },
        };
```
this will however disable automatic updates by Tampermonkey. 
