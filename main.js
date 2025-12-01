const { createApp, ref, onMounted, nextTick } = Vue;

// TypeScript-style Interfaces (als JSDoc Kommentare)
/**
 * @typedef {Object} MastodonToot
 * @property {string} id
 * @property {string} content
 * @property {string} created_at
 * @property {Array<{type: string}>} media_attachments
 */

/**
 * @typedef {Object} AppCredentials
 * @property {string} client_id
 * @property {string} client_secret
 */

/**
 * @typedef {Object} ConfigData
 * @property {string} key
 * @property {string} instanceUrl
 * @property {string} clientId
 * @property {string} clientSecret
 */

/**
 * @typedef {Object} AuthData
 * @property {string} key
 * @property {string} accessToken
 * @property {string} username
 * @property {string} userId
 */

/**
 * @typedef {Object} WrappedStats
 * @property {number} totalToots
 * @property {number} avgLength
 * @property {number} withMedia
 * @property {Array<{tag: string, count: number}>} topHashtags
 * @property {number} replies
 * @property {number} mostActiveHour
 * @property {string} mostActiveDay
 * @property {number} longestStreak
 * @property {number} longestToot
 * @property {number} shortestToot
 * @property {number} medianLength
 * @property {number} totalWords
 * @property {number} avgWords
 * @property {{morning: number, afternoon: number, evening: number, night: number}} timeDistribution
 * @property {number} totalLinks
 * @property {number} totalMentions
 * @property {number} boosts
 * @property {number} privateToots
 * @property {{name: string, count: number}} mostActiveMonth
 */

/**
 * @typedef {Object} WrappedCard
 * @property {[string, string]} gradient
 * @property {string|number} value
 * @property {string} label
 */

createApp({
    setup() {
        // Reactive State
        const instanceUrl = ref('');
        const clientId = ref(null);
        const clientSecret = ref(null);
        const accessToken = ref(null);
        const username = ref('');
        const userId = ref(null);
        const isAuthenticated = ref(false);
        const isLoading = ref(false);
        const isImporting = ref(false);
        const importComplete = ref(false);
        const importProgress = ref(0);
        const statusText = ref('');
        const error = ref(null);
        const totalToots = ref(0);
        const importTime = ref(0);
        const db = ref(null);
        const toots = ref([]);
        const showToots = ref(false);
        const wrappedData = ref(null);
        const isGenerating = ref(false);
        const existingTootsCount = ref(0);
        const cardsList = ref(['total','social', 'hashtags', 'activity', 'longest', 'words', 'timeofday', 'month']);
        const cardsValue = ref({});


        // Database Functions
        /**
         * @returns {Promise<IDBDatabase>}
         */
        const initDB = () => {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('MastodonDB', 1);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    db.value = request.result;
                    resolve(request.result);
                };

                request.onupgradeneeded = (event) => {
                    const database = event.target.result;
                    if (!database.objectStoreNames.contains('toots')) {
                        database.createObjectStore('toots', { keyPath: 'id' });
                    }
                    if (!database.objectStoreNames.contains('config')) {
                        database.createObjectStore('config', { keyPath: 'key' });
                    }
                };
            });
        };

        /**
         * @param {string} storeName
         * @param {any} data
         * @returns {Promise<void>}
         */
        const saveToDb = (storeName, data) => {
            return new Promise((resolve, reject) => {
                const transaction = db.value.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.put(data);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        };

        /**
         * @param {string} storeName
         * @param {string} key
         * @returns {Promise<any>}
         */
        const getFromDb = (storeName, key) => {
            return new Promise((resolve, reject) => {
                const transaction = db.value.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        };

        /**
         * @param {string} storeName
         * @returns {Promise<any[]>}
         */
        const getAllFromDb = (storeName) => {
            return new Promise((resolve, reject) => {
                const transaction = db.value.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        };

        // Auth Functions
        const startAuth = async () => {
            error.value = null;
            isLoading.value = true;

            try {
                let instance = instanceUrl.value.trim();
                if (!instance.startsWith('http')) {
                    instance = 'https://' + instance;
                }
                instanceUrl.value = instance;

                const appResponse = await fetch(`${instance}/api/v1/apps`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_name: 'Mastodon Toot Importer',
                        redirect_uris: window.location.origin + window.location.pathname,
                        scopes: 'read',
                        website: window.location.origin
                    })
                });

                if (!appResponse.ok) throw new Error('App-Registrierung fehlgeschlagen');

                const appData = await appResponse.json();
                clientId.value = appData.client_id;
                clientSecret.value = appData.client_secret;

                await saveToDb('config', {
                    key: 'credentials',
                    instanceUrl: instanceUrl.value,
                    clientId: clientId.value,
                    clientSecret: clientSecret.value
                });

                const authUrl = `${instance}/oauth/authorize?client_id=${clientId.value}&redirect_uri=${encodeURIComponent(window.location.origin + window.location.pathname)}&response_type=code&scope=read`;
                window.location.href = authUrl;

            } catch (err) {
                error.value = 'Fehler bei der Verbindung: ' + err.message;
                isLoading.value = false;
            }
        };

        const checkAuthFromUrl = async () => {
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get('code');

            if (code) {
                isLoading.value = true;

                try {
                    const config = await getFromDb('config', 'credentials');
                    if (!config) throw new Error('Keine gespeicherten Credentials gefunden');

                    instanceUrl.value = config.instanceUrl;
                    clientId.value = config.clientId;
                    clientSecret.value = config.clientSecret;

                    const tokenResponse = await fetch(`${instanceUrl.value}/oauth/token`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            client_id: clientId.value,
                            client_secret: clientSecret.value,
                            redirect_uri: window.location.origin + window.location.pathname,
                            grant_type: 'authorization_code',
                            code: code,
                            scope: 'read'
                        })
                    });

                    if (!tokenResponse.ok) throw new Error('Token-Abruf fehlgeschlagen');

                    const tokenData = await tokenResponse.json();
                    accessToken.value = tokenData.access_token;

                    const userResponse = await fetch(`${instanceUrl.value}/api/v1/accounts/verify_credentials`, {
                        headers: { 'Authorization': `Bearer ${accessToken.value}` }
                    });

                    if (!userResponse.ok) throw new Error('User-Abruf fehlgeschlagen');

                    const userData = await userResponse.json();
                    username.value = userData.username;
                    userId.value = userData.id;
                    isAuthenticated.value = true;

                    await saveToDb('config', {
                        key: 'auth',
                        accessToken: accessToken.value,
                        username: username.value,
                        userId: userId.value
                    });

                    window.history.replaceState({}, document.title, window.location.pathname);

                    // Prüfe existierende Toots
                    const existingToots = await getAllFromDb('toots');
                    existingTootsCount.value = existingToots.length;

                } catch (err) {
                    error.value = 'Authentifizierung fehlgeschlagen: ' + err.message;
                } finally {
                    isLoading.value = false;
                }
            } else {
                const auth = await getFromDb('config', 'auth');
                const creds = await getFromDb('config', 'credentials');

                if (auth && creds) {
                    accessToken.value = auth.accessToken;
                    username.value = auth.username;
                    userId.value = auth.userId;
                    instanceUrl.value = creds.instanceUrl;
                    clientId.value = creds.clientId;
                    clientSecret.value = creds.clientSecret;
                    isAuthenticated.value = true;

                    // Prüfe existierende Toots
                    const existingToots = await getAllFromDb('toots');
                    existingTootsCount.value = existingToots.length;
                }
            }
        };

        // Import Functions
        const startImport = async () => {
            isImporting.value = true;
            error.value = null;
            importProgress.value = 0;
            const startTime = Date.now();

            try {
                const oneYearAgo = new Date();
                oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

                let allToots = [];
                let maxId = null;
                let hasMore = true;
                let page = 0;

                statusText.value = 'Lade Toots...';

                while (hasMore) {
                    page++;
                    let url = `${instanceUrl.value}/api/v1/accounts/${userId.value}/statuses?limit=40`;
                    if (maxId) url += `&max_id=${maxId}`;

                    const response = await fetch(url, {
                        headers: { 'Authorization': `Bearer ${accessToken.value}` }
                    });

                    if (!response.ok) throw new Error('Fehler beim Abrufen der Toots');

                    const tootsPage = await response.json();

                    if (tootsPage.length === 0) {
                        hasMore = false;
                        break;
                    }

                    const filteredToots = tootsPage.filter(toot => {
                        const tootDate = new Date(toot.created_at);
                        return tootDate >= oneYearAgo;
                    });

                    allToots.push(...filteredToots);

                    const oldestToot = tootsPage[tootsPage.length - 1];
                    const oldestDate = new Date(oldestToot.created_at);

                    if (oldestDate < oneYearAgo) {
                        hasMore = false;
                    } else {
                        maxId = oldestToot.id;
                    }

                    statusText.value = `Seite ${page}: ${allToots.length} Toots gefunden...`;
                    importProgress.value = Math.min(95, page * 10);

                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                statusText.value = 'Speichere Toots in Datenbank...';
                for (const toot of allToots) {
                    await saveToDb('toots', toot);
                }

                totalToots.value = allToots.length;
                importTime.value = Date.now() - startTime;
                importProgress.value = 100;
                importComplete.value = true;
                existingTootsCount.value = allToots.length;
                statusText.value = 'Import abgeschlossen!';
                await generateWrapped();

            } catch (err) {
                error.value = 'Import-Fehler: ' + err.message;
            } finally {
                isImporting.value = false;
            }
        };

        // View Functions
        const viewToots = async () => {
            toots.value = await getAllFromDb('toots');
            toots.value = toots.value.filter(toot => !toot.reblog).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            showToots.value = !showToots.value;
        };

        /**
         * @param {string} dateString
         * @returns {string}
         */
        const formatDate = (dateString) => {
            const date = new Date(dateString);
            return date.toLocaleDateString('de-DE', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        };

        const resetApp = async () => {
            if (confirm('Möchtest du wirklich alle lokalen Daten löschen und neu starten?')) {
                const transaction = db.value.transaction(['toots', 'config'], 'readwrite');
                transaction.objectStore('toots').clear();
                transaction.objectStore('config').clear();

                instanceUrl.value = '';
                clientId.value = null;
                clientSecret.value = null;
                accessToken.value = null;
                username.value = '';
                userId.value = null;
                isAuthenticated.value = false;
                importComplete.value = false;
                totalToots.value = 0;
                toots.value = [];
                showToots.value = false;
                wrappedData.value = null;
                existingTootsCount.value = 0;
            }
        };

        // Wrapped Functions
        const generateWrapped = async () => {
            isGenerating.value = true;

            await new Promise(resolve => setTimeout(resolve, 500));

            try {
                const allToots = await getAllFromDb('toots');

                // Re-Toots rausfiltern
                const filteredToots = allToots.filter(toot => !toot?.reblog);

                const stats = {
                    totalToots: filteredToots.length,
                    totalRetoots: allToots.length - filteredToots.length,
                    avgLength: 0,
                    withMedia: 0,
                    topHashtags: [],
                    replies: 0,
                    mostActiveHour: 0,
                    mostActiveDay: '',
                    longestStreak: 0,
                    longestToot: 0,
                    shortestToot: Infinity,
                    medianLength: 0,
                    totalWords: 0,
                    avgWords: 0,
                    timeDistribution: { morning: 0, afternoon: 0, evening: 0, night: 0 },
                    totalLinks: 0,
                    totalMentions: 0,
                    boosts: 0,
                    privateToots: 0,
                    mostActiveMonth: { name: '', count: 0 },
                    totalFavorites: 0,
                    totalReblogs: 0
                };

                let totalChars = 0;
                const hashtagMap = {};
                const hourMap = {};
                const dayMap = {};
                const monthMap = {};
                const lengths = [];
                let totalWords = 0;


                filteredToots.forEach(toot => {
                    const text = toot.content.replace(/<[^>]*>/g, '');
                    console.log(text);
                    const length = text.length;
                    totalChars += length;
                    lengths.push(length);

                    // Längster und kürzester Toot
                    if (length > stats.longestToot) stats.longestToot = length;
                    if (length < stats.shortestToot && length > 0) stats.shortestToot = length;

                    // Wörter zählen
                    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
                    totalWords += words.length;

                    // Medien
                    if (toot.media_attachments && toot.media_attachments.length > 0) {
                        stats.withMedia++;
                    }

                    // Replies
                    if (toot.in_reply_to_id) {
                        stats.replies++;
                    }

                    // Boosts
                    if (toot.reblog) {
                        stats.boosts++;
                    }

                    // Private Toots
                    if (toot.visibility === 'private' || toot.visibility === 'direct') {
                        stats.privateToots++;
                    }

                    // Links zählen
                    const linkMatches = text.match(/https?:\/\/[^\s]+/g);
                    if (linkMatches) stats.totalLinks += linkMatches.length;

                    // Erwähnungen zählen
                    const mentionMatches = text.match(/@\w+/g);
                    if (mentionMatches) stats.totalMentions += mentionMatches.length;

                    // Zeit-Analyse
                    const date = new Date(toot.created_at);
                    const hour = date.getHours();
                    const dayName = date.toLocaleDateString('de-DE', { weekday: 'long' });
                    const monthName = date.toLocaleDateString('de-DE', { month: 'long' });

                    hourMap[hour] = (hourMap[hour] || 0) + 1;
                    dayMap[dayName] = (dayMap[dayName] || 0) + 1;
                    monthMap[monthName] = (monthMap[monthName] || 0) + 1;

                    // Tageszeit-Verteilung
                    if (hour >= 6 && hour < 12) stats.timeDistribution.morning++;
                    else if (hour >= 12 && hour < 18) stats.timeDistribution.afternoon++;
                    else if (hour >= 18 && hour < 24) stats.timeDistribution.evening++;
                    else stats.timeDistribution.night++;

                    // Favoriten zählen
                    stats.totalFavorites += toot.favourites_count || 0;
                    // Reblogs zählen
                    stats.totalReblogs += toot.reblogs_count || 0;

                    // Hashtags
                    const hashtagRegex = /#(\w+)/g;
                    let match;
                    while ((match = hashtagRegex.exec(text)) !== null) {
                        const tag = match[1].toLowerCase();
                        hashtagMap[tag] = (hashtagMap[tag] || 0) + 1;
                    }
                });

                // Durchschnittswerte
                stats.avgLength = Math.round(totalChars / filteredToots.length);
                stats.totalWords = totalWords;
                stats.avgWords = Math.round(totalWords / filteredToots.length);

                // Median berechnen
                lengths.sort((a, b) => a - b);
                const mid = Math.floor(lengths.length / 2);
                stats.medianLength = lengths.length % 2 === 0
                    ? Math.round((lengths[mid - 1] + lengths[mid]) / 2)
                    : lengths[mid];

                // Prozentuale Verteilung
                const total = filteredToots.length;
                stats.timeDistribution.morning = Math.round((stats.timeDistribution.morning / total) * 100);
                stats.timeDistribution.afternoon = Math.round((stats.timeDistribution.afternoon / total) * 100);
                stats.timeDistribution.evening = Math.round((stats.timeDistribution.evening / total) * 100);
                stats.timeDistribution.night = Math.round((stats.timeDistribution.night / total) * 100);


                // Top Hashtags
                stats.topHashtags = Object.entries(hashtagMap)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([tag, count]) => ({ tag, count }));

                // Aktivste Stunde
                const maxHour = Object.entries(hourMap).sort((a, b) => b[1] - a[1])[0];
                stats.mostActiveHour = maxHour ? parseInt(maxHour[0]) : 12;

                // Aktivster Tag
                const maxDay = Object.entries(dayMap).sort((a, b) => b[1] - a[1])[0];
                stats.mostActiveDay = maxDay ? maxDay[0] : 'Montag';

                // Aktivster Monat
                const maxMonth = Object.entries(monthMap).sort((a, b) => b[1] - a[1])[0];
                stats.mostActiveMonth = maxMonth ? { name: maxMonth[0], count: maxMonth[1] } : { name: 'Januar', count: 0 };

                // Längste Serie berechnen
                const dates = filteredToots
                    .map(t => new Date(t.created_at).toDateString())
                    .sort();
                const uniqueDates = [...new Set(dates)];

                let currentStreak = 1;
                let maxStreak = 1;

                for (let i = 1; i < uniqueDates.length; i++) {
                    const prev = new Date(uniqueDates[i - 1]);
                    const curr = new Date(uniqueDates[i]);
                    const diff = Math.floor((curr - prev) / (1000 * 60 * 60 * 24));

                    if (diff === 1) {
                        currentStreak++;
                        if (currentStreak > maxStreak) maxStreak = currentStreak;
                    } else {
                        currentStreak = 1;
                    }
                }

                stats.longestStreak = maxStreak;

                wrappedData.value = stats;

                await nextTick();
                setTimeout(() => {
                    const wrappedElement = document.querySelector('.wrapped-container');
                    if (wrappedElement) {
                        wrappedElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 100);
                downloadWrappedCard('total', false);
                downloadWrappedCard('hashtags', false);
                downloadWrappedCard('activity', false);
                downloadWrappedCard('longest', false);
                downloadWrappedCard('words', false);
                downloadWrappedCard('timeofday', false);
                downloadWrappedCard('social', false);
                downloadWrappedCard('month', false);
            } catch (err) {
                error.value = 'Fehler beim Generieren: ' + err.message;
            } finally {
                isGenerating.value = false;
            }
        };

        /**
         * @param {'total'|'hashtags'|'activity'|'longest'|'words'|'timeofday'|'social'|'month'} type
         * @returns {Promise<void>}
         */
        const downloadWrappedCard = async (type, download = true) => {
            const header = `Mastodon Wrapped ${new Date().getFullYear()}`;
            cardsValue.value = {
                total: {
                    gradient: ['#fa709a', '#fee140'],
                    header: header,
                    value: wrappedData.value.totalToots.toString(),
                    label: 'Toots gepostet',
                    extraList: [
                        `📝 ${wrappedData.value.avgLength} Ø Zeichen`, 
                        `🖼️ ${wrappedData.value.withMedia} mit Medien`, 
                        `💬 ${wrappedData.value.replies} Antworten`, 
                        `♻️ ${wrappedData.value.totalRetoots} Re-Toots`
                        ],
                    altText: `Toots gepostet ${new Date().getFullYear()}, ${wrappedData.value.totalToots} Toots gepostet mit durchschnittlich ${wrappedData.value.avgLength} Zeichen. Davon hatten ${wrappedData.value.withMedia} Medien, ${wrappedData.value.replies} waren Antworten und ${wrappedData.value.totalRetoots} Re-Toots.`
                },
                hashtags: {
                    gradient: ['#4facfe', '#00f2fe'],
                    header: header,
                    value: wrappedData.value.topHashtags.slice(0, 1).map(t => `#${t.tag} (${t.count}×)`).join(' '),
                    label: 'Top Hashtags',
                    extraList: wrappedData.value.topHashtags.slice(1, 6).map(t => `#${t.tag} (${t.count}×)`),
                    altText: `Top Hashtags in ${new Date().getFullYear()} waren: ${wrappedData.value.topHashtags.map(t => `#${t.tag} (${t.count} mal)`).join(', ')}.`
                },
                activity: {
                    gradient: ['#43e97b', '#38f9d7'],
                    header: header,
                    value: `${wrappedData.value.mostActiveHour}:00 Uhr`,
                    label: 'Aktivste Stunde',
                    extra: `${wrappedData.value.mostActiveDay} | ${wrappedData.value.longestStreak} Tage Serie`,
                    altText: `Aktivste Stunde in ${new Date().getFullYear()} war ${wrappedData.value.mostActiveHour}:00 Uhr. Dein längster Aktivitätszeitraum betrug ${wrappedData.value.longestStreak} Tage, am aktivsten warst du an einem ${wrappedData.value.mostActiveDay}.`
                },
                longest: {
                    gradient: ['#fa709a', '#fee140'],
                    header: header,
                    value: wrappedData.value.longestToot.toString(),
                    label: 'Längster Toot (Zeichen)',
                    extraList: [
                        `📏 Kürzester: ${wrappedData.value.shortestToot} Zeichen`,
                        `📊 Median: ${wrappedData.value.medianLength} Zeichen`
                    ],
                    altText: `Längster Toot in ${new Date().getFullYear()} hatte ${wrappedData.value.longestToot} Zeichen. Der kürzeste Toot hatte ${wrappedData.value.shortestToot} Zeichen und der Median lag bei ${wrappedData.value.medianLength} Zeichen.`
                },
                words: {
                    gradient: ['#f093fb', '#f5576c'],
                    header: header,
                    value: wrappedData.value.totalWords.toString(),
                    label: 'Wörter geschrieben',
                    extraList: [
                        `📖 Das sind ${Math.round(wrappedData.value.totalWords / 250)} Buchseiten!`,
                        `💬 Ø ${wrappedData.value.avgWords} Wörter pro Toot`
                    ],
                    altText: `Wörter geschrieben in ${new Date().getFullYear()} insgesamt ${wrappedData.value.totalWords} Wörter, was etwa ${Math.round(wrappedData.value.totalWords / 250)} Buchseiten entspricht. Im Durchschnitt enthielt jeder Toot ${wrappedData.value.avgWords} Wörter.`
                },
                timeofday: {
                    gradient: ['#4facfe', '#00f2fe'],
                    header: header,
                    value: 'Tageszeit',
                    label: '',
                    extraList: [
                        `🌅 Morgen (6-12): ${wrappedData.value.timeDistribution.morning}%`,
                        `☀️ Mittag (12-18): ${wrappedData.value.timeDistribution.afternoon}%`,
                        `🌆 Abend (18-24): ${wrappedData.value.timeDistribution.evening}%`,
                        `🌙 Nacht (0-6): ${wrappedData.value.timeDistribution.night}%`
                    ],
                    altText: `Tageszeit in ${new Date().getFullYear()} hast du deine Toots zu folgenden Tageszeiten gepostet: ${wrappedData.value.timeDistribution.morning}% am Morgen, ${wrappedData.value.timeDistribution.afternoon}% am Mittag, ${wrappedData.value.timeDistribution.evening}% am Abend und ${wrappedData.value.timeDistribution.night}% in der Nacht.`
                },
                social: {
                    gradient: ['#43e97b', '#38f9d7'],
                    header: header,
                    value: `${wrappedData.value.totalMentions.toString()} 👥 Erwähnt`,
                    label: 'Sozial & Vernetzt',
                    extraList: [
                        `⭐ ${wrappedData.value.totalFavorites} Favoriten erhalten`,
                        `🔁 ${wrappedData.value.totalReblogs} Reblogs erhalten`,
                        `🔗 ${wrappedData.value.totalLinks} Links geteilt`,
                        `🔒 ${wrappedData.value.privateToots} Private Toots`
                    ],
                    altText: `In ${new Date().getFullYear()} hast du ${wrappedData.value.totalMentions} Erwähnungen gemacht, ${wrappedData.value.totalLinks} Links geteilt, ${wrappedData.value.totalReblogs} Reblogs erhalten, ${wrappedData.value.totalFavorites} Favoriten erhalten und ${wrappedData.value.privateToots} private Toots gepostet.`
                },
                month: {
                    gradient: ['#f093fb', '#f5576c'],
                    header: header,
                    value: wrappedData.value.mostActiveMonth.name,
                    label: 'Aktivster Monat',
                    extra: `${wrappedData.value.mostActiveMonth.count} Toots`,
                    altText: `Dein aktivster Monat in ${new Date().getFullYear()} war ${wrappedData.value.mostActiveMonth.name} mit ${wrappedData.value.mostActiveMonth.count} Toots.`
                }
            };

            const card = cardsValue.value[type];
            await createAndDownloadImage(card, type, download);
        };

        /**
         * @param {WrappedCard} card
         * @param {string} type
         * @returns {Promise<void>}
         */
        const createAndDownloadImage = async (card, type, download = true) => {
            let canvas;
            if (document.querySelector(`#canvas-${type}`)) {
                canvas = document.getElementById(`canvas-${type}`);
            } else {
                canvas = document.createElement('canvas');
            }
            canvas.width = 1080;
            canvas.height = 1080;
            const ctx = canvas.getContext('2d');

            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, card.gradient[0]);
            gradient.addColorStop(1, card.gradient[1]);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';

            // Header
            ctx.font = 'bold 40px Arial';
            ctx.globalAlpha = 0.9;
            ctx.fillText(card.header || 'MASTODON WRAPPED', canvas.width / 2, 150);
            ctx.globalAlpha = 1;

            // Value
            const fontSize = card.value.length > 10 ? 90 : 220;
            ctx.font = `bold ${fontSize}px Arial`;
            ctx.fillText(card.value, canvas.width / 2, 550);

            // Label
            ctx.font = 'bold 50px Arial';
            ctx.globalAlpha = 0.95;
            ctx.fillText(card.label, canvas.width / 2, 680);
            ctx.globalAlpha = 1;

            // Extra Info
            if (card.extra) {
                ctx.font = '32px Arial';
                ctx.globalAlpha = 0.9;
                const maxWidth = 950;
                const words = card.extra.split(' ');
                let line = '';
                let y = 780;

                for (let i = 0; i < words.length; i++) {
                    const testLine = line + words[i] + ' ';
                    const metrics = ctx.measureText(testLine);
                    if (metrics.width > maxWidth && i > 0) {
                        ctx.fillText(line, canvas.width / 2, y);
                        line = words[i] + ' ';
                        y += 40;
                    } else {
                        line = testLine;
                    }
                }
                ctx.fillText(line, canvas.width / 2, y);
                ctx.globalAlpha = 1;
            }

            // Extra Info unter einander
            if (card.extraList) {
                ctx.font = '32px Arial';
                ctx.globalAlpha = 0.9;
                const startY = 780;
                const lineHeight = 40;
                card.extraList.forEach((lineText, index) => {
                    ctx.fillText(lineText, canvas.width / 2, startY + index * lineHeight);
                });
                ctx.globalAlpha = 1;
            }

            // Footer
            ctx.font = 'bold 35px Arial';
            ctx.globalAlpha = 0.8;
            ctx.fillText(`@${username.value}@${instanceUrl.value.replace('https://', '')}`, canvas.width / 2, 980);
            if (!download) {
                return
            }
            canvas.toBlob(blob => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `mastodon-wrapped-${type}-${username.value}.png`;
                a.click();
                URL.revokeObjectURL(url);
            }, 'image/png');
        };

        const downloadAllCards = async () => {
            const types = ['total', 'hashtags', 'activity', 'longest', 'words', 'timeofday', 'social', 'month'];
            for (const type of types) {
                await downloadWrappedCard(type);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        };

        // LifecyclecardsList
        onMounted(async () => {
            await initDB();
            await checkAuthFromUrl();
        });

        // Return all reactive state and methods
        return {
            instanceUrl,
            username,
            isAuthenticated,
            isLoading,
            isImporting,
            importComplete,
            importProgress,
            statusText,
            error,
            totalToots,
            importTime,
            toots,
            showToots,
            wrappedData,
            isGenerating,
            existingTootsCount,
            cardsList,
            cardsValue,
            startAuth,
            startImport,
            viewToots,
            formatDate,
            resetApp,
            generateWrapped,
            downloadWrappedCard,
            downloadAllCards
        };
    }
}).mount('#app');