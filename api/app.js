const { App } = require("@slack/bolt");
const addQuotes = require('./quotes.js');
const schedule = require('node-schedule');
const moment = require('moment');
const Airtable = require('airtable');
require('dotenv').config();

Airtable.configure({
	endpointUrl: 'https://api.airtable.com',
	apiKey: process.env.AIRTABLE_API_KEY
});
const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_MILLION_CHANNEL;
const port = process.env.PORT ?? 3000;

const goalDate = '6/1/2027';
const goalNumber = 400000;

let lastValid = 0;
let lastCounter = "";
let dayStart = 0;

const app = new App({
	token: token,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	customRoutes: [
		{
			path: '/health-check',
			method: ['GET'],
			handler: (req, res) => {
				res.end('OK');
			},
		},
		{
			path: '/api/currentNumber',
			method: ['GET'],
			handler: (req, res) => {
				res.setHeader('Content-Type', 'application/json');
				res.end(`{"number":${lastValid}}`);
			},
		}
	],
});

function extractNumber(txt) {
	let array = ["-", " ", "\n"]
	let lowestIndex = Infinity;
	for (let i of array) {
		if (txt.includes(i)) {
			lowestIndex = Math.min(lowestIndex, txt.indexOf(i));
		}
	}
	if (lowestIndex !== Infinity) return txt.slice(0, lowestIndex);
	return txt;
}

async function fetchLatest(id) {
	try {
		const result = await app.client.conversations.history({
			token: token,
			channel: id,
			limit: 100,
		});
		let number;
		for (let x = 0; x < result.messages.length; x++) {
			number = extractNumber(
				result.messages[x].text,
			);

			if (!isNaN(number)) break;
		}
		return number;
	} catch (error) {
		console.error(error);
	}
}

async function fetchOldest(id) {
	try {
		const result = await app.client.conversations.history({
			token: token,
			channel: id,
			oldest: Math.floor(Date.now() / 1000) - 86400, //debug: 1609295166, actual: Math.floor(Date.now() / 1000) - 86400
			inclusive: false,
		});
		let number;
		for (let x = result.messages.length - 2; x >= 0; x--) {
			number = extractNumber(
				result.messages[x].text,
			);

			if (!isNaN(number)) break;
		}
		return number - 1;
	} catch (error) {
		console.error(error);
	}
}

async function publishMessage(id, text) {
	try {
		await app.client.chat.postMessage({
			token: token,
			channel: id,
			text: text
		});
	} catch (error) {
		console.error(error);
	}
}

async function publishEphemeral(id, text, userId) {
	try {
		await app.client.chat.postEphemeral({
			token: token,
			channel: id,
			user: userId,
			text: text
		});
	} catch (error) {
		console.error(error);
	}
}

async function postReaction(id, emoji, ts) {
	try {
		await app.client.reactions.add({
			token: token,
			channel: id,
			name: emoji,
			timestamp: ts
		});
	} catch (error) {
		console.error(error)
	}
}

async function pinMessage(id, ts) {
	try {
		await app.client.pins.add({
			token: token,
			channel: id,
			timestamp: ts
		})
	} catch (error) {
		console.error(error)
	}
}

async function addData(db, object) {
	base(db).create(object, function(err, record) {
		if (err) {
			console.error(err);
			return;
		}
	})
}

async function setData(db, fieldName, fieldValue, object) {
	try {
		const record = await getData(db, `{${fieldName}} = '${fieldValue}'`);
		if (!!record) {
			await base(db).update(record.id, object);
		} else {
			if (!object[fieldName]) object[fieldName] = fieldValue;
			await addData(db, object);
		}
	} catch (err) {
		console.error(err);
	}
}

async function getData(db, filterFormula) {
	try {
		const obj = await base(db)
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

async function getAverage() {
	try {
		const obj = await base('increase')
			.select({
				maxRecords: 30,
				sort: [{ field: 'Date', direction: 'desc' }]
			})
			.firstPage();

		let sum = 0;
		obj.forEach((item) => (sum += item.fields.increase));

		return sum / obj.length;
	} catch (error) {
		console.error(error);
	}
}

async function report() {
	console.log("Writing daily report...");
	let oldest = startToday; // await fetchOldest(channel);
	let latest = lastValid; // await fetchLatest(channel);
	let diff = latest - oldest;
	addData('increase', {
		"Date": moment().subtract(1, "days").format("YYYY-MM-DD"),
		"increase": diff,
		"start": startToday,
	})
	await setData("misc", "Name", "startToday", {
		"Number": startToday,
	});
	startToday = latest;
	let averageSpeed = Math.max(0, await getAverage());
	let pastThousandsGoal = Math.floor(latest / 1000) * 1000;
	let goals = predictSpeed(goalDate, goalNumber, latest);
	let message =
		`Today we've went from *${oldest}* to *${latest}*!
		- :arrow_upper_right: The day's progress: *+${diff}*
		- :chart_with_upwards_trend: Average daily speed: *${Math.round(averageSpeed)}*
		- :round_pushpin: Our current goal is to reach *${goalNumber}* by *${moment(goalDate).format('MMMM DD, YYYY')}.*
		- :calendar: If we want to get there on time, we need to count by at least *+${Math.ceil(goals[1])}* a day.
		- :1234: Here's a number to aim for today: *${Math.ceil(parseInt(latest) + parseInt(goals[1]))}*`;
	if (pastThousandsGoal > oldest && pastThousandsGoal <= latest) {
		let messageWithCelebration = `:tada: Congratulations! We've went past ${pastThousandsGoal}! :tada: \n` + message;
		publishMessage(channel, addQuotes(messageWithCelebration, goals, averageSpeed));
	} else {
		publishMessage(channel, addQuotes(message, goals, averageSpeed));
	}

	console.log("Sent daily report.");
};

function predictSpeed(goalDate, goalNumber, currentNumber) {
	let today = new Date();
	let goal = new Date(goalDate);
	let timeRemaining = goal - today;
	let daysRemaining
	if (timeRemaining >= 0) {
		daysRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60 * 24));
	} else {
		daysRemaining = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
	}
	let neededSpeed = (goalNumber - currentNumber) / Math.abs(daysRemaining);
	return [daysRemaining, neededSpeed];

}

app.event('message', async (body) => {
	try {
		let e = body.event;
		if (typeof e.subtype === "undefined" && /\d/.test(e.text[0])) {
			let number = extractNumber(e.text);
			if (isNaN(number)) return;
			let ts = e.ts;
			let c = e.channel;
			let u = e.user;
			let nextNumber = lastValid + 1;
			let reacted = false;
			if (u === lastCounter) {
				postReaction(c, "bangbang", ts);
				publishEphemeral(channel, `You can't count twice in a row, minion.`, u);
			} else if (Number(number) === nextNumber) {
				await setData("misc", "Name", "lastValid", {
					"Name": "lastValid",
					"Number": nextNumber,
					"UserId": u,
				});
				lastCounter = u;
				lastValid = nextNumber;
				if (number % 1000 === 0) {
					reacted = true;
					postReaction(c, "tada", ts);
				}
				if (number % 5000 === 0) {
					reacted = true;
					pinMessage(c, ts);
				}
				if (number.slice(-2) === '69') {
					reacted = true;
					postReaction(c, "ok_hand", ts);
				}
				if (number.slice(-3) === '666') {
					reacted = true;
					postReaction(c, "smiling_imp", ts);
				} if (number.slice(-3) === number.slice(0, 3).split("").reverse().join("")) {
					reacted = true;
					postReaction(c, "tacocat", ts);
				}
				if (!reacted) {
					postReaction(c, "white_check_mark", ts);
				}
			} else {
				postReaction(c, "bangbang", ts);
				publishEphemeral(channel, `That's the wrong number, minion, it should be *${nextNumber}.*`, u);
			}
		}
	} catch (err) {
		console.error(err);
	}
});

app.event('app_mention', async (body) => {
	try {
		let e = body.event;
		let c = e.channel;
		let choose = Math.floor(Math.random() * 7);
		let messageArray = [
			"DO NOT BOTHER ME. I AM SLEEPING.",
			"AAAAAAAA!!! THE SUN! *pulls curtains closed* I nearly got _burnt_ that time, you pathetic little minions! Next time, DO NOT WAKE ME.",
			"What do you want, human weakling?",
			"Hrmh? Is Count von Corgo pissing on the lawn _again_?",
			"What is it? Are you going too slow that you need another supernatural being to help you _speed-count_? If so, you've found the wrong one, because this supernatural being is _trying to sleep!_",
			"HISSSSSSSSSSS!",
			"Minions, I had _three hours_ of sleep yesterday, and I am trying to catch up. Please, _leave me alone to sleep._",
		];

		publishMessage(c, messageArray[choose]);

		console.log("App mentioned.");
	} catch (err) {
		console.error(err)
	}
});

(async () => {
	try {
		const lvRecord = await getData("misc", "{Name} = 'lastValid'");
		if (!!lvRecord) {
			lastValid = lvRecord.fields.Number;
			lastCounter = lvRecord.fields.UserId;
		} else {
			addData("misc", {
				"Name": "lastValid",
				"Number": 0,
				"UserId": "",
			});
		}
		const stRecord = await getData("misc", "{Name} = 'startToday'");
		if (!!stRecord) {
			startToday = stRecord.fields.Number;
		} else {
			addData("misc", {
				"Name": "startToday",
				"Number": 0,
			});
		}
		await app.start(port);
		schedule.scheduleJob('0 0 * * *', report);
		console.log(`Started bot, listening on port ${port}`)
	} catch (error) {
		console.error(error);
	}
})();
