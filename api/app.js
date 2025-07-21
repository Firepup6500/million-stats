import { App } from "@slack/bolt";
import { base as _base, configure } from "airtable";
import dotenv from "dotenv";
import moment from "moment";
import { scheduleJob } from "node-schedule";
import { addQuote } from "./quotes.js";

dotenv.config();

configure({
	endpointUrl: "https://api.airtable.com",
	apiKey: process.env.AIRTABLE_API_KEY,
});

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

const base = _base(
	ensureDefined(
		process.env.AIRTABLE_BASE_ID,
		"AIRTABLE_BASE_ID is not defined",
	),
);

const token = ensureDefined(
	process.env.SLACK_BOT_TOKEN,
	"SLACK_BOT_TOKEN is not defined",
);

const channel = ensureDefined(
	process.env.SLACK_MILLION_CHANNEL,
	"SLACK_MILLION_CHANNEL is not defined",
);

const port = Number(process.env.PORT) ?? 3000;
if (!Number.isInteger(port)) throw new Error("PORT must be an integer");

const goalDate = new Date("2027/06/01");
const goalNumber = 400000;

let lastValid = 0;
let lastCounter = "";
let startToday = 0;

const app = new App({
	token: token,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	customRoutes: [
		{
			path: "/health-check",
			method: ["GET"],
			handler: (_req, res) => {
				res.end("OK");
			},
		},
		{
			path: "/api/currentNumber",
			method: ["GET"],
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

	let lowestIndex = Infinity;
	for (const seperator of numberSeperators) {
		if (txt.includes(seperator)) {
			lowestIndex = Math.min(lowestIndex, txt.indexOf(seperator));
		}
	}
	if (lowestIndex !== Infinity) return txt.slice(0, lowestIndex);

	return txt;
}

/**
 * Publishes a message to a channel.
 * @param {string} channelId the channel id
 * @param {string} text the text to publish
 */
async function publishMessage(channelId, text) {
	try {
		await app.client.chat.postMessage({
			token: token,
			channel: channelId,
			text: text,
		});
	} catch (error) {
		console.error(error);
	}
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
		console.error(error);
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
		console.error(error);
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
		console.error(error);
	}
}

/**
 * Adds data to a table.
 * @param {string} table the table name
 * @param {Record<string, any>} object the data to add
 */
async function addData(table, object) {
	try {
		await base(table).create(object);
	} catch (error) {
		console.error(error);
	}
}

/**
 * Adds data to a table.
 *
 * If the field is already present with the specified value, it will be updated.
 * @param {string} table the table name
 * @param {string} fieldName the field name
 * @param {string} fieldValue the field value
 * @param {Record<string, any>} object the data to set
 */
async function setData(table, fieldName, fieldValue, object) {
	try {
		const record = await getData(table, `{${fieldName}} = '${fieldValue}'`);
		if (record) {
			await base(table).update(record.id, object);
		} else {
			if (!object[fieldName]) object[fieldName] = fieldValue;
			await addData(table, object);
		}
	} catch (err) {
		console.error(err);
	}
}

/**
 * Gets data from a table.
 * @param {string} table the table name
 * @param {string} filterFormula the filter to get the data required
 * @returns the data
 */
async function getData(table, filterFormula) {
	try {
		const obj = await base(table)
			.select({
				filterByFormula: filterFormula,
				maxRecords: 1,
			})
			.firstPage();

		return obj[0];
	} catch (error) {
		console.error(error);
	}
}

/**
 * Gets the average increase from the last 30 days.
 * @returns the average increase
 */
async function getAverage() {
	try {
		const obj = await base("increase")
			.select({
				maxRecords: 30,
				sort: [{ field: "Date", direction: "desc" }],
			})
			.firstPage();

		let sum = 0;
		obj.forEach((item) => {
			if (typeof item.fields.increase === "number") {
				sum += item.fields.increase;
			} else {
				console.warn(`Invalid increase value for item: ${item.id}`);
			}
		});

		return sum / obj.length;
	} catch (error) {
		console.error(error);
	}
}

/**
 * Sends a report to Slack
 */
async function report() {
	console.log("Writing daily report...");
	const oldest = startToday; // await fetchOldest(channel);
	const latest = lastValid; // await fetchLatest(channel);
	const diff = latest - oldest;

	await addData("increase", {
		Date: moment().subtract(1, "days").format("YYYY-MM-DD"),
		increase: diff,
		start: startToday,
	});

	await setData("misc", "Name", "startToday", {
		Number: startToday,
	});

	startToday = latest;

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
		- :round_pushpin: Our current goal is to reach *${goalNumber}* by *${moment(goalDate).format("MMMM DD, YYYY")}.*
		- :calendar: If we want to get there on time, we need to count by at least *+${Math.ceil(predictedSpeed)}* a day.
		- :1234: Here's a number to aim for today: *${Math.ceil(latest + predictedSpeed)}*`;
	if (pastThousandsGoal > oldest && pastThousandsGoal <= latest) {
		const messageWithCelebration = `:tada: Congratulations! We've went past ${pastThousandsGoal}! :tada: \n${message}`;
		await publishMessage(
			channel,
			addQuote(
				messageWithCelebration,
				daysRemaining,
				predictedSpeed,
				averageSpeed,
			),
		);
	} else {
		await publishMessage(
			channel,
			addQuote(message, daysRemaining, predictedSpeed, averageSpeed),
		);
	}

	console.log("Sent daily report.");
}

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

app.event("message", async (body) => {
	try {
		const e = body.event;
		if (typeof e.subtype === "undefined" && e.text) {
			const extractedNumber = extractNumber(e.text);
			const number = Number(extractedNumber);
			if (!Number.isNaN(number)) return;

			const ts = e.ts;
			const c = e.channel;
			const u = e.user;
			const nextNumber = lastValid + 1;
			let reacted = false;

			if (u === lastCounter) {
				await postReaction(c, "bangbang", ts);
				await publishEphemeral(
					channel,
					`You can't count twice in a row, minion.`,
					u,
				);
			} else if (Number(number) === nextNumber) {
				/** @type {Array<Promise<void>>} */
				const reactions = [];

				await setData("misc", "Name", "lastValid", {
					Number: nextNumber,
					UserId: u,
				});
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
					if (extractedNumber.endsWith("666")) {
						reacted = true;
						reactions.push(postReaction(c, "smiling_imp", ts));
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
						channel,
						`That's the wrong number, minion, it should be *${nextNumber}.*`,
						u,
					);
				}
			}
		}
	} catch (err) {
		console.error(err);
	}
});

app.event("app_mention", async (body) => {
	try {
		const e = body.event;
		const c = e.channel;
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
		publishMessage(c, messageArray[choose]);

		console.log("App mentioned.");
	} catch (err) {
		console.error(err);
	}
});

try {
	const lvRecord = await getData("misc", "{Name} = 'lastValid'");
	if (lvRecord) {
		// @ts-expect-error lastValid is always a number, unless the table was somehow setup incorrectly. Skill issue tbh
		lastValid = lvRecord.fields.Number;
		// @ts-expect-error lastCounter is always a string. Ditto.
		lastCounter = lvRecord.fields.UserId;
	} else {
		addData("misc", {
			Name: "lastValid",
			Number: 0,
			UserId: "",
		});
	}
	const stRecord = await getData("misc", "{Name} = 'startToday'");
	if (stRecord) {
		// @ts-expect-error startToday is always a number. Ditto.
		startToday = stRecord.fields.Number;
	} else {
		addData("misc", {
			Name: "startToday",
			Number: 0,
		});
	}
	await app.start(port);
	scheduleJob("0 0 * * *", report);
	console.log(`Started bot, listening on port ${port}`);
} catch (error) {
	console.error(error);
}
