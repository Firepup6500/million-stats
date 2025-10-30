const { App } = require("@slack/bolt");
const sql = require("sqlite3");
const { DateTime } = require("luxon");
const { scheduleJob } = require("node-schedule");
const { addQuote } = require("./quotes.js");

require("dotenv").config();

const db = new sql.Database("database.db");

/**
 * Ensures that a value is defined, else throws an error.
 * @template T
 * @param {T | undefined} value
 * @param {string} message
 * @returns
 */
function ensureDefined(value, message) {
	if (!value) throw new Error(message);
	return value;
}

const token = ensureDefined(
	process.env.SLACK_BOT_TOKEN,
	"SLACK_BOT_TOKEN is not defined",
);

const countChannel = ensureDefined(
	process.env.SLACK_MILLION_CHANNEL,
	"SLACK_MILLION_CHANNEL is not defined",
);

// optional channel for slack logging, but it's not important enough to warrant being ensured
const loggingChannel = process.env.SLACK_LOGGING_CHANNEL;

const doLogging = !!loggingChannel;

if (!doLogging) {
	console.warn("WARN: No logging channel! No logs of any kind will be sent to slack!")
}

const debugLogging = false && doLogging; // TODO: disable whatever warning is going to be thrown by this

if (debugLogging) {
	console.warn("WARN: App is logging debug info!")
}

const port = Number(process.env.PORT) ?? 3000;
if (!Number.isInteger(port)) throw new Error("PORT must be an integer");

// Really, we don't care too much about bot owners being set, it's just a debugging thing
const botOwners = process.env.SLACK_OWNER_IDS ? process.env.SLACK_OWNER_IDS.split(',') : [];

const goalDate = new Date(!!process.env.DATE? process.env.DATE : "3027/01/01");
if (Number.isNaN(goalDate.getDate())) throw new Error("DATE must be a valid date (e.g. yyyy/mm/dd)")

const goalNumber = Number(process.env.GOAL) ?? 1000000;
if (!Number.isInteger(goalNumber)) throw new Error("GOAL must be an integer");

let lastValid = 0;
let lastCounter = "";
let startToday = 0;

let currentId = 0;
let idToHandle = 0;

const app = new App({
	token: token,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	customRoutes: [
		{
			path: "/health-check",
			method: "GET",
			handler: (_req, res) => {
				res.end("OK");
			},
		},
		{
			path: "/api/currentNumber",
			method: "GET",
			handler: (_req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.end(`{"number":${lastValid}}`);
			},
		},
	],
});

/**
 * Extracts the first number from a string.
 * @param {string} txt the text to extract number from
 * @returns a string representing the extracted number
 */
function extractNumber(txt) {
	// seperates the number from the rest of the message
	const numberSeperators = ["-", " ", "\n"];
	const applicableSeperators = numberSeperators.filter((seperator) =>
		txt.includes(seperator),
	);

	let lowestIndex = Infinity;
	for (const seperator of applicableSeperators) {
		lowestIndex = Math.min(lowestIndex, txt.indexOf(seperator));
	}
	if (lowestIndex !== Infinity) return txt.slice(0, lowestIndex);

	return txt;
}

/**
 * Publishes a message to a channel.
 * @param {string} channelId the channel id
 * @param {string} text the text to publish
 * @param {boolean} silent if errors should be silent
 */
async function publishMessage(channelId, text, silent = false) {
	try {
		await app.client.chat.postMessage({
			token: token,
			channel: channelId,
			text: text,
		});
	} catch (error) {
		if (!silent) {
			publishError(String(error), error);
		}
	}
}

/**
 * Publishes an error message to the logging channel and to the console, if logging is enabled, otherwise only to the console
 * @param {string} message the message
 * @param {object} error the error object
*/
async function publishError(message, error) {
	console.error('ERROR: ' + message);
	if (!!error) console.error(error);
	if (doLogging) await publishMessage(loggingChannel, 'ERROR: ' + message, true);
}

/**
 * Publishes a debug message to the logging channel and to the console, if debug logging is enabled, otherwise is a No-op
 * @param {string} message the message
*/
async function publishDebug(message) {
	if (debugLogging) {
		console.debug('DEBUG: ' + message);
		await publishMessage(loggingChannel, 'DEBUG: ' + message, true);
	}
}

/**
 * Publishes an info message to the logging channel and to the console, if logging is enabled, otherwise only to the console
 * @param {string} message the message
*/
async function publishInfo(message) {
	console.info('INFO: ' + message);
	if (doLogging) await publishMessage(loggingChannel, 'INFO: ' + message, true);
}

/**
 * Publishes an ephemeral message to a channel.
 * @param {string} channelId the channel id
 * @param {string} text the text to publish
 * @param {string} userId the user id to send the message to
 */
async function publishEphemeral(channelId, text, userId) {
	try {
		await app.client.chat.postEphemeral({
			token: token,
			channel: channelId,
			user: userId,
			text: text,
		});
	} catch (error) {
		publishError(String(error), error);
	}
}

/**
 * Posts a reaction to a message.
 * @param {string} channelId the channel id
 * @param {string} emoji the emoji to react with
 * @param {string} ts the timestamp of the message to react to
 */
async function postReaction(channelId, emoji, ts) {
	try {
		await app.client.reactions.add({
			token: token,
			channel: channelId,
			name: emoji,
			timestamp: ts,
		});
	} catch (error) {
		if (error.data?.error == "already_reacted") {
			publishError(`Tried to post a duplicate '${emoji}' reaction to message ${ts} in ${channelId}`)
		} else {
			publishError(String(error), error);
		}
	}
}

/**
 * Pins a message to a channel.
 * @param {string} channelId the channel id
 * @param {string} ts the timestamp of the message to pin
 */
async function pinMessage(channelId, ts) {
	try {
		await app.client.pins.add({
			token: token,
			channel: channelId,
			timestamp: ts,
		});
	} catch (error) {
		publishError(String(error), error);
	}
}

/**
 * Adds or updates a misc entry
 * @param {string} name the record name
 * @param {number} number the number of the entry
 * @param {string|null} [userId=null] the user id of the entry
 */
async function setMisc(name, number, userId = null) {
	return new Promise((resolve) => {
		db.run('INSERT INTO misc(name, number, userId) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET number = EXCLUDED.number, userId = EXCLUDED.userId', [name, number, userId], (err) => {
			if (err) {
				publishError(String(err), err)
			}
			resolve(undefined)
		})
	})
}

/**
 * Adds an increase record for a day.
 * @param {string} date the date of the record in ISO format
 * @param {number} increase the increase in the day
 * @param {number} start the starting number of the day
 */
async function addIncrease(date, increase, start) {
	return new Promise((resolve) => {
		db.run('INSERT INTO increase(date, change, start) VALUES (?, ?, ?)', [date, increase, start], (err) => {
			if (err) {
				publishError(String(err), err)
			}
			resolve(undefined)
		})
	})
}

/**
 * Gets an entry from the misc table.
 * @param {string} name the name of the misc entry
 * @returns the entry if found
 */
async function getMisc(name) {
	return new Promise((resolve) => {
		db.get('SELECT number, userId FROM misc WHERE name = ?', [name], (err, row) => {
			if (err) {
				publishError(String(err), err)
			}
			resolve(row)
		})
	})
}

async function getIncrease(days) {
	return new Promise((resolve) => {
		db.get('SELECT change FROM increase ORDER BY date DESC LIMIT ?', [days], (err, row) => {
			if (err) {
				publishError(String(err), err)
			}
			resolve(row)
		})
	})
}

/**
 * Gets the average increase from the last 30 days.
 * @returns the average increase
 */
async function getAverage() {
	try {
		const obj = await getIncrease(30)

		const sum = obj.reduce(
			(sum, currentItem) => sum + Number(currentItem.change),
			0,
		);

		return sum / obj.length;
	} catch (error) {
		publishError(String(error), error);
	}
}

/**
 * Sends a report to Slack
 */
async function report() {
	try {
		publishInfo("Writing daily report...");
		const oldest = startToday; // await fetchOldest(countChannel);
		const latest = lastValid; // await fetchLatest(countChannel);
		const diff = latest - oldest;

		addIncrease(DateTime.now().minus({ days: 1 }).toISODate(), diff, startToday)

		startToday = latest;

		await setMisc('startToday', startToday)

		// so Slack doesn't fail, just set the average to 0 if it's null
		const averageSpeed = Math.max(0, (await getAverage()) ?? 0);
		const pastThousandsGoal = Math.floor(latest / 1000) * 1000;
		const [daysRemaining, predictedSpeed] = predictSpeed(
			goalDate,
			goalNumber,
			latest,
		);

		const message = `Today we've went from *${oldest}* to *${latest}*!
			- :arrow_upper_right: The day's progress: *+${diff}*
			- :chart_with_upwards_trend: Average daily speed: *${Math.round(averageSpeed)}*
			- :round_pushpin: Our current goal is to reach *${goalNumber}* by *${DateTime.fromJSDate(goalDate).toLocaleString(DateTime.DATE_MED)}.*
			- :calendar: If we want to get there on time, we need to count by at least *+${Math.ceil(predictedSpeed)}* a day.
			- :1234: Here's a number to aim for today: *${Math.ceil(latest + predictedSpeed)}*`;
		if (pastThousandsGoal > oldest && pastThousandsGoal <= latest) {
			const messageWithCelebration = `:tada: Congratulations! We've went past ${pastThousandsGoal}! :tada: \n${message}`;
			await publishMessage(
				countChannel,
				addQuote(
					messageWithCelebration,
					daysRemaining,
					predictedSpeed,
					averageSpeed,
				),
			);
		} else {
			await publishMessage(
				countChannel,
				addQuote(message, daysRemaining, predictedSpeed, averageSpeed),
			);
		}

		publishInfo("Sent daily report.");
	} catch (error) {
		publishError(String(error), error);
	}
}

app.command('/send-report', async ({ command, ack, respond }) => {
	try {
		await ack();

		if (!botOwners.includes(command.user_id)) {
			await respond({
				response_type: 'ephemeral',
				text: "Minion, you don't have privileges to tell me what to do",
			});
			return;
		}

		report();
	} catch (error) {
		publishError(String(error), error);
	}
});

/**
 * Predicts how much users need to count by each day to reach the goal on time.
 * @param {Date} goalDate the date to hit the goal by
 * @param {number} goalNumber the number to hit the goal by
 * @param {number} currentNumber the current number
 * @returns {[number, number]} The days remaining and the predicted speed to get to the goal in time respectively
 */
function predictSpeed(goalDate, goalNumber, currentNumber) {
	const today = new Date();
	// @ts-expect-error Dates get auto-converted to numbers
	const timeRemaining = goalDate - today;
	let daysRemaining;
	if (timeRemaining >= 0) {
		daysRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60 * 24));
	} else {
		daysRemaining = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
	}
	const neededSpeed = (goalNumber - currentNumber) / Math.abs(daysRemaining);
	return [daysRemaining, neededSpeed];
}

// Taken from https://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep#39914235
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

app.event("message", async (body) => {
	try {
		const e = body.event;
		if ((typeof e.subtype === "undefined" || e.subtype === 'file_share') && e.text) {
			const extractedNumber = extractNumber(e.text);
			const number = Number(extractedNumber);
			if (Number.isNaN(number)) return;

			const myId = currentId++;
			let sleepTime = 0;
			publishDebug(`Will sleep? ${myId != idToHandle}`)
			while (myId != idToHandle && sleepTime < 120) {
				await sleep(1000);
				sleepTime++; // failsafe, in case we somehow get stuck
			}


			const ts = e.ts;
			const thread_ts = e.thread_ts;
			const c = e.channel;
			const u = e.user;
			const nextNumber = lastValid + 1;
			let reacted = false;

			publishDebug(JSON.stringify(e));

			if (!!thread_ts && thread_ts !== ts) {
				await postReaction(c, "bangbang", ts);
				await publishEphemeral(c, "Minion, this isn't funny. Count in the main channel, not a thread.", u);
			} else if (u === lastCounter) {
				await postReaction(c, "bangbang", ts);
				await publishEphemeral(
					c,
					"You can't count twice in a row, minion.",
					u,
				);
			} else if (number === nextNumber) {
				/** @type {Array<Promise<void>>} */
				const reactions = [];

				await setMisc('lastValid', nextNumber, u)
				lastCounter = u;
				lastValid = nextNumber;

				if (number % 1000 === 0) {
					reacted = true;
					reactions.push(postReaction(c, "tada", ts));
				}

				if (number % 5000 === 0) {
					reacted = true;
					reactions.push(pinMessage(c, ts));
				}

				if (extractedNumber.endsWith("69")) {
					reacted = true;
					reactions.push(postReaction(c, "ok_hand", ts));
				}

				if (extractedNumber.endsWith("666")) {
					reacted = true;
					reactions.push(postReaction(c, "smiling_imp", ts));
				}

				if (extractedNumber.endsWith("650")) {
					reacted = true;
					reactions.push(postReaction(c, "firepup650-v2", ts));
				}

				if (extractedNumber.endsWith("404")) {
					reacted = true;
					reactions.push(postReaction(c, "Food-when", ts));
				}

				const isPalindrome =
					extractedNumber.slice(-3) ===
					extractedNumber.slice(0, 3).split("").reverse().join("");

				if (isPalindrome) {
					reacted = true;
					reactions.push(postReaction(c, "tacocat", ts));
				}

				if (!reacted) {
					reactions.push(postReaction(c, "white_check_mark", ts));
				}

				await Promise.all(reactions);
			} else {
				await postReaction(c, "bangbang", ts);
				await publishEphemeral(
					c,
					`That's the wrong number, minion, it should be *${nextNumber}.*`,
					u,
				);
			}
			idToHandle++;
		}
	} catch (error) {
		publishError(String(error), error);
	}
});

app.event("app_mention", async (body) => {
	try {
		const e = body.event;
		const c = e.channel;
		const ts = e.ts;
		const u = e.user;
		const thread_ts = e.thread_ts;
		const choose = Math.floor(Math.random() * 7);
		const messageArray = [
			"DO NOT BOTHER ME. I AM SLEEPING.",
			"AAAAAAAA!!! THE SUN! *pulls curtains closed* I nearly got _burnt_ that time, you pathetic little minions! Next time, DO NOT WAKE ME.",
			"What do you want, human weakling?",
			"Hrmh? Is Count von Corgo pissing on the lawn _again_?",
			"What is it? Are you going too slow that you need another supernatural being to help you _speed-count_? If so, you've found the wrong one, because this supernatural being is _trying to sleep!_",
			"HISSSSSSSSSSS!",
			"Minions, I had _three hours_ of sleep yesterday, and I am trying to catch up. Please, _leave me alone to sleep._",
		];

		// @ts-expect-error choose is always in bounds
		if (!!thread_ts && thread_ts !== ts) {
			publishEphemeral(c, messageArray[choose], u);
			publishInfo("App mentioned in a thread.");
		} else {
			publishMessage(c, messageArray[choose]);
			publishInfo("App mentioned.");
		}
	} catch (error) {
		publishError(String(error), error);
	}
});

(async () => {
	try {
		if (debugLogging) console.debug("DEBUG: Getting last valid number from airtable...")
		const lvRecord = await getMisc('lastValid');
		if (lvRecord) {
			lastValid = lvRecord.number;
			lastCounter = lvRecord.userId;
		} else {
			setMisc('lastValid', 0)
		}
		if (debugLogging) console.debug("DEBUG: Getting today's starting number from airtable...")
		const stRecord = await getMisc("startToday");
		if (stRecord) {
			startToday = stRecord.number;
		} else {
			setMisc('startToday', 0)
		}
		console.info("INFO: Trying to startup...")
		await app.start(port);
		//await report(); // debugging
		scheduleJob("0 0 * * *", report);
		publishInfo(`Started bot, listening on port ${port}`);
	} catch (error) {
		publishError(String(error), error);
	}
})();
