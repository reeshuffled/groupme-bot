// program constants
const MAX_MSG_LEN = 1000;

// networking imports
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");

// Firebase database imports and setup
const firebase = require('firebase-admin');
firebase.initializeApp({
    credential: firebase.credential.cert(require("")),
    databaseURL: ""
});

const picturesRef = firebase.database().ref("/pictures");

// file manipulation import
const fs = require("fs");
const jimp = require("jimp");
const shortid = require("shortid");
const luni = require("lunicode");

// latex rendering imports
const svg2img = require("svg2img");
const mjAPI = require("mathjax-node");
mjAPI.config({ MathJax: {} });
mjAPI.start();

// global variables
const pointsRef = firebase.database().ref("/points");
let PICTURES_RECORD = [];
let POINTS_RECORD = [];
let lastMessage = "";

/**
 * Initialize the application by connecting to the database, loading data, and starting the
 * webserver.
 */
(async function init() {
    // if in local dev mode, load .env variables
    const flags = process.argv.slice(2);
    if (flags.length && flags[0] == "--local")
    {
        require("dotenv").config();
    }

    // get pictures from database
    PICTURES_RECORD = await getPictures();

    // get points from database
    POINTS_RECORD = await getPoints();

    // start web server
    startServer();
})();

/**
 * Start the webserver.
 */
function startServer() {
    // create express app server
    const app = express();
    app.use(bodyParser.json());

    // get the port to be running on and listen on that port
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`groupme-bot is listening on port ${port}`));

    // listen for POST requests from GroupMe
    
    app.post("/", (req, res) => {
        // get message text
        const message = req.body["text"];

        // store last message (do not store commands)
        if (!message.startsWith("/"))
        {
            lastMessage = message;
        }
            
        // stop the bot from responding to itself
        if (req.body["sender_type"] == "bot") 
        {
            res.end();
        
            return;
        }

        // process messages for points
        const record = POINTS_RECORD.find(x => x.user_id == req.body["user_id"]);
        if (record)
        {
            let points = 0;

            if (req.body["attachments"].length > 0) 
            {
                // get three points for sending an image
                if (req.body["attachments"].type == "image")
                {
                    points = 3;
                }
            }
            else
            {
                // get one point for using a command
                if (message.startsWith("/"))
                {
                    points = 1;
                }
                // get two points for sending a message
                else
                {
                    points = 2;
                }
            }

            // add points to the user's balance
            record.points += points;

            // update points record in database
            pointsRef.set(POINTS_RECORD);

            // have a counter that counts from 0-9 and resets on 9 to update to batch updates?
        }

        // parse the message for command
        const parsedData = parseCommand(message);
        const sender = req.body.sender_id;

        // send a message response if valid command
        if (parsedData && parsedData.command) 
        {
            const command = parsedData.command;
            const args = parsedData.args;
            const attachments = req.body.attachments.length ? req.body.attachments : [];

            handleCommand(command, args, attachments, sender);
        }

        // send an empty http response to prevent heroku timeouts
        res.end();
    });
}

/**
 * Retrieve saved pictures and captions from Firebase.
 */
async function getPictures() {
    const snapshot = await picturesRef.once("value");
    const data = snapshot.val();

    return Object.entries(data);
}

/**
 * Retrieve user point balances from Firebase.
 */
async function getPoints() {
    const snapshot = await pointsRef.once("value");
    const data = snapshot.val();

    return data;
}

/**
 * If the command is valid, execute the functionality associated with it.
 * @param {String} command 
 * @param {String[]} args 
 * @param {Object[]} attachments 
 * @param {String} sender 
 */
function handleCommand(command, args, attachments, sender) {
    const COMMAND_MAP = {
        "bal": () => getUserBalance(sender, attachments),
        "cat": getCat,
        "commands": () => sendMessage(Object.keys(COMMAND_MAP).map(x => "/" + x).join(", ")),
        "deepfry": () => deepfryPicture(attachments, args),
        "drunk": () => drunkText(args.join(" ")),
        "drunkprev": () => drunkText(lastMessage),
        "flip": () => flipText(args.join(" ")),
        "flipprev": () => flipText(lastMessage),
        "glitch": () => glitchText(args.join(" ")),
        "glitchPrev": () => glitchText(lastMessage),
        "joke": getJoke,
        "leaderboard": getLeaderboard,
        "listpics": listPictureCaptions,
        "mention": () => mentionUsers(args),
        "mirror": () => mirrorText(args.join(" ")),
        "mirrorprev": () => mirrorText(lastMessage),
        "mock": () => mockText(args.join(" ")),
        "mockPrev": () => mockText(lastMessage),
        "pay": () => payUser(sender, args, attachments),
        "pic": () => getPicture(args),
        "picslist": listPictureCaptions,
        "ping": () => sendMessage("Pong!"),
        "pog": () => sendMessage("", [{ "type": "image", "url": "https://i.groupme.com/128x128.png.89c49b2a867c42f3a2d8f077f9c8681b" }]),
        "say": () => sendMessage(args.join(" ")),
        "select": () => selectRandomUser(args),
        "shout": () => shoutText(args.join(" ")),
        "shoutprev": () => shoutText(lastMessage),
        "shrug": () => sendMessage("¯\\_(ツ)_/¯"),
        "submit": () => submitPicture(attachments, args),
        "tex": () => renderLatex(args.join(" ")),
        "toppics": () => getTopPictures(),
        "uwu": () => uwuText(args.join(" ")),
        "uwuprev": () => uwuText(lastMessage),
        "wiki": getRandomWikipediaArticle
    };

    if (command in COMMAND_MAP) 
    {
        COMMAND_MAP[command]();
    }

    return;
}


function getTopPictures() {
    // sort pictures by numAppearances in descending order
    PICTURES_RECORD.sort((a, b) => b[1].numAppearances - a[1].numAppearances);

    sendMessage(PICTURES_RECORD.slice(0, 10)
        .filter(([key, pic]) => pic.numAppearances != 0)
        .map(([key, pic], i) =>  `${i + 1}. ${pic.caption} - ${pic.numAppearances}`)
        .join("\n")
    );
}

function payUser(sender, args, attachments) {
    // sanity checks
    if (!args.length) return;
    if (!attachments.length) return;

    const mention = attachments.find(x => x.type == "mentions");

    if (!mention) return;

    // get the amount of payment
    const amount = parseInt(args[args.length - 1]);
    
    // validate amount of payment
    if (isNaN(amount)) return;

    // get the points of the sender and recipient
    const senderRecord = POINTS_RECORD.find(x => x.user_id == sender);
    const recipientRecord = POINTS_RECORD.find(x => x.user_id == mention.user_ids[0]);

    if (amount < 0) {
        sendMessage("You cannot send negative points.");

        return;
    }

    // if the user cannot afford this transaction
    if (senderRecord.points - amount < 0) {
        sendMessage("You do not have sufficient points for this transaction.");

        return;
    }

    // complete transaction
    senderRecord.points -= amount;
    recipientRecord.points += amount;

    // update points record in database
    pointsRef.set(POINTS_RECORD, (err) => {
        if (err) return;

        sendMessage("Transaction complete.");
    });
}

/**
 * Get the points balance of the user using the command.
 * @param {String} sender 
 */
async function getUserBalance(sender, attachments)
{
    if (attachments.length)
    {
        const mention = attachments.find(x => x.type == "mentions");

        if (mention)
        {
            sender = mention.user_ids[0];
        }
    }

    // get the points of the sender
    const record = POINTS_RECORD.find(x => x.user_id == sender);

    // get all the members of the group
    let response = await axios.get("https://api.groupme.com/v3/groups/" + process.env.GROUP_ID + "?token=" + process.env.ACCESS_TOKEN);
    const members = response.data.response.members;

    // look through all members
    for (const member of members) 
    {
        if (member.user_id == sender)
        {
            sendMessage(`${member.nickname}'s current balance is ${record.points} points.`);

            return;
        }
    }
}

/**
 * Renders a LaTeX string and sends the image of the render.
 * @param {String} text 
 */
function renderLatex(text) {
    // do not render empty string
    if (text == "") return;

    mjAPI.typeset(
        {
            math: text,
            format: "TeX",
            svg: true,
        }, 
        (data) => {
            if (!data.errors) { 
                svg2img(data.svg, async (err, buffer) => {
                    if (err) return;

                    let id = shortid();

                    fs.writeFileSync(`${id}.png`, buffer);

                    // get binary data of new file
                    let binaryImgData = fs.readFileSync(`${id}.png`);
 
                    // upload the image to the Groupme Image Service
                    let res = await axios.post("https://image.groupme.com/pictures", binaryImgData, {
                        headers: {
                            "Content-Type": "image/png",
                            "X-Access-Token": process.env.ACCESS_TOKEN
                        }
                    });

                    fs.unlinkSync(`${id}.png`);
 
                    // get the GroupMe picture URL
                    const gmImgUrl = res.data.payload.picture_url;

                    // send the latex image
                    sendMessage("", [{ "type": "image", "url": gmImgUrl }]);
                });
            }
        }
    );
}

/**
 * Randomly manipulate the text to make it seem like a drunk person wrote it.
 * @param {String} text
 */
function drunkText(text)
{
    // do not send an empty message
    if (text.length == "") return;

    const VOWELS = "aeiouAEIOU".split("");
    const PROX_KEYS = {
        "a": ['q', 'w', 'z', 'x'],
        "b": ['v', 'f', 'g', 'h', 'n'],
        "c": ['x', 's', 'd', 'f', 'v'],
        "d": ['x', 's', 'w', 'e', 'r', 'f', 'v', 'c'],
        "e": ['w', 's', 'd', 'f', 'r'],
        "f": ['c', 'd', 'e', 'r', 't', 'g', 'b', 'v'],
        "g": ['r', 'f', 'v', 't', 'b', 'y', 'h', 'n'],
        "h": ['b', 'g', 't', 'y', 'u', 'j', 'm', 'n'],
        "i": ['u', 'j', 'k', 'l', 'o'],
        "j": ['n', 'h', 'y', 'u', 'i', 'k', 'm'],
        "k": ['u', 'j', 'm', 'l', 'o'],
        "l": ['p', 'o', 'i', 'k', 'm'],
        "m": ['n', 'h', 'j', 'k', 'l'],
        "n": ['b', 'g', 'h', 'j', 'm'],
        "o": ['i', 'k', 'l', 'p'],
        "p": ['o', 'l'],
        "r": ['e', 'd', 'f', 'g', 't'],
        "s": ['q', 'w', 'e', 'z', 'x', 'c'],
        "t": ['r', 'f', 'g', 'h', 'y'],
        "u": ['y', 'h', 'j', 'k', 'i'],
        "v": ['', 'c', 'd', 'f', 'g', 'b'],
        "w": ['q', 'a', 's', 'd', 'e'],
        "x": ['z', 'a', 's', 'd', 'c'],
        "y": ['t', 'g', 'h', 'j', 'u'],
        "z": ['x', 's', 'a'],
        "1": ['q', 'w'],
        "2": ['q', 'w', 'e'],
        "3": ['w', 'e', 'r'],
        "4": ['e', 'r', 't'],
        "5": ['r', 't', 'y'],
        "6": ['t', 'y', 'u'],
        "7": ['y', 'u', 'i'],
        "8": ['u', 'i', 'o'],
        "9": ['i', 'o', 'p'],
        "0": ['o', 'p']
    };

    let diminishingTypoProbability = 0.20;

    const chars = text.split("");
    let drunkText = "";
    for (let i = 0; i < chars.length; i++)
    {
        let currentCharacter = chars[i];

        // transform only letter characters
        if (currentCharacter != " " && !"!@#$%^&*()'\":,./<>?-+=".includes(currentCharacter))
        {
            // do not apply typos to first or last characters
            let prev = text.charAt(i - 1);
            let next = text.charAt(i + 1);
            let isWordStart = prev == "" || prev == " ";
            let isWordEnd   = next == "" || next == " ";

            // RNG to see if we create a typo (as long as is not first or last character of word)
            if (Math.random() < diminishingTypoProbability && !isWordStart && !isWordEnd) {
                // get a random character from the proximPROX_KEYS[currentCharacter.toLowerCase()]al keys array and append it to the new text string
                const typoKeys = PROX_KEYS[currentCharacter.toLowerCase()];
                console.log(currentCharacter);
                console.log(typoKeys);
                drunkText += typoKeys[Math.floor(Math.random() * typoKeys.length)];

                diminishingTypoProbability -= 0.025;
            }
            // if we don't create a typo, flip a coin to change case
            else if (Math.random() < 0.1) {
                drunkText += Math.round(Math.random()) ? currentCharacter.toUpperCase() : currentCharacter.toLowerCase();
            }
            // if we don't change case, flip a coin to repeat characters
            else if (Math.random() < 0.2) {
                // have it be at least one character so we don't delete this character from the string
                drunkText += currentCharacter;

                // keep on continuing slurring the text
                let diminishingRepitionProbability = 0.2;
                while (Math.random() < diminishingRepitionProbability)
                {
                    drunkText += currentCharacter;

                    diminishingRepitionProbability -= 0.05;
                }
            }
            // if no special cases, just add the original character
            else {
                drunkText += currentCharacter;
            }
        }
        // we ignore spaces and symbols
        else
        {
            drunkText += currentCharacter;
        }
    }

    sendMessage(drunkText);
}

/**
 * Sends a message in "mock" case which is where upper and lower cases are randomly mixed in the same word.
 * @param {String} text 
 */
function mockText(text) {
    // do not send an empty message
    if (text.length == "") return;

    // randomly apply upper and lower case transformations to the text.
    sendMessage(
        text
            .split("")
            .map(x => Math.round(Math.random()) ? x.toUpperCase() : x.toLowerCase())
            .join("")
    );
}

/**
 * Sends a message in all upper case.
 * @param {String} text 
 */
function shoutText(text) {
    // do not send an empty message
    if (text.length == "") return;

    sendMessage(text.toUpperCase());
}

/**
 * Sends a message where the letters have an added Unicode "glitch" text effect.
 * @param {String} text 
 */
function glitchText(text) {
    // do not send an empty message
    if (text.length == "") return;

    // apply Unicode glitch effect
    sendMessage(luni.tools.creepify.encode(text));
}

/**
 * Sends a message where the letters have been converted to their Unicode upside-down counterparts.
 * @param {String} text 
 */
function flipText(text) {
    // do not send an empty message
    if (text.length == "") return;

    // apply upside-down effect
    sendMessage(luni.tools.flip.encode(text));
}

/**
 * Sends a message where the letters have been converted to their Unicode mirrored counterparts.
 * @param {String} text 
 */
function mirrorText(text) {
    // do not send an empty message
    if (text.length == "") return;

    // apply mirror effect
    sendMessage(luni.tools.mirror.encode(text));
}

/**
 * Sends a message where it has been uwu-ified.
 * @param {String} text 
 */
function uwuText(text) {
    // made by Jordan Roberts
    let prev = "", uwu = "";

    for (let c of text) {
        if (c == 'R' || c == 'L') {
            uwu += 'W';
        }
        else if (c == 'r' || c == 'l') {
            uwu += 'w';
        }
        else if ((c == "O" || c == "o") && (prev == "M" || prev == "m" || prev == "N" || prev == "n")) {
            uwu += 'y';
            uwu += c;
        } 
        else {
            uwu += c;
        } 

        prev = c;
    }

    const faces = [" owo", " uwu", " :3"];
    face = faces[Math.floor(Math.random() * faces.length)];
    uwu += face;

    sendMessage(uwu);
}

/**
 * Retrieves a joke from an API endpoint and sends it as a message.
 */
async function getJoke() {
    // get joke from api
    const response = await axios("https://official-joke-api.appspot.com/random_joke");

    // sanity check
    if (!response.data) return;

    sendMessage(response.data.setup + "\n" + response.data.punchline);
}

/**
 * Sends a message with all of the picture captions that are stored in the database.
 */
async function listPictureCaptions() {
    // get all saved picture captions in case-insensitive alphabetical order
    const captions = PICTURES_RECORD
        .map(([key, value]) => value.caption)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    let messageBuffer = "";
    for (const caption of captions)
    {
        // if the message buffer can handle another caption with a comma and space
        if (messageBuffer.length + caption.length + 2 < MAX_MSG_LEN)
        {
            messageBuffer += caption + ", ";
        }
        // if the message buffer needs to be flushed (sent and reset)
        else 
        {
            // remove trailing whitespace and comma at end
            messageBuffer = messageBuffer.trim();
            messageBuffer = messageBuffer.substring(0, messageBuffer.length - 1);

            // send the message buffer and wait for the message to be sent before proceeding
            await axios.post("https://api.groupme.com/v3/bots/post", {
                bot_id: process.env.BOT_ID,
                text: messageBuffer,
            });

            // reset message buffer
            messageBuffer = "";
        }
    }
}

/**
 * Gets a random picture or the picture with the specified caption and sends it to the group.
 * @param {String[]} args 
 */
function getPicture(args) {
    let data;

    // if searching by caption
    if (args.length) 
    {
        // reassemble caption
        const caption = args.join(" ").trim();

        // case-insensitive search thru pic captions
        const regex = new RegExp(["^", caption, "$"].join(""), "i");
        const matches = PICTURES_RECORD.filter(([ id, pic ]) => regex.test(pic.caption));

        // if there was a match found
        if (matches.length) 
        {
            const [ id, pic ] = matches[0];

            // update the number of times the picture has been seen
            pic.numAppearances++;
            picturesRef.child(id).update(pic);

            // set the data element to the picture that we found from the database
            data = pic;
        }
        else 
        {
            return;
        }
    }
    // if getting random
    else 
    {
        // sort pictures by numAppearances in ascending order
        PICTURES_RECORD.sort((a, b) => a[1].numAppearances - b[1].numAppearances);

        // get the pic that has been seen the least
        const min = PICTURES_RECORD[0];

        // get the pictures that have been seen the least amount of times
        // i.e. the same amount of times as the least seen picture
        const leastShown = PICTURES_RECORD.filter(x => x[1].numAppearances == min[1].numAppearances);

        // get a random picture from the least shown list
        // this is to prevent sending in the order of objects stored in the database
        const [ id, randPic ] = leastShown[Math.floor(Math.random() * leastShown.length)];

        // update the number of times the picture has been seen
        randPic.numAppearances++;
        picturesRef.child(id).update(randPic);

        // set the data element to the random picture
        data = randPic;
    }

    // sanity check
    if (!data) return;

    // send the image
    if (data.img_url.includes(".jpeg"))
    {
        sendMessage(data.caption, [{ "type": "image", "url": data.img_url }]);
    }
    // send the video
    else
    {
        sendMessage(data.caption, [{ "type": "video", "url": data.img_url, "preview_url": data.img_url }]);
    }
}

/**
 * Gets a random picture or the picture with the specified caption and applies the "deepfry" image effect
 * and sends it to the group.
 * @param {Object[]} attachments 
 * @param {String[]} args 
 */
async function deepfryPicture(attachments, args) {
    let data;

    // get all the pictures from message attachments
    let pictures = attachments.filter(x => x.type == "image");

    // if there are pictures attached
    if (pictures.length) {
        // download the image
        axios({
            method: "get",
            url: pictures[0].url,
            responseType: "stream"
        })
        .then(response => {
            return new Promise((resolve, reject) => {
                let file = `${shortid()}.jpeg`;
                let writer = fs.createWriteStream(file);

                response.data.pipe(writer);

                let error = null;

                writer.on('error', err => {
                    error = err;
                    writer.close();
                    reject(err);
                });

                writer.on('close', () => {
                    if (!error) {
                        resolve(file);
                    }
                });
            });
        })
        .then(file => {
            let newFile = `${shortid()}.jpg`;

            // write image file
            jimp.read(file)
                .then(image => {
                    image
                        .quality(1)
                        .dither565()
                        .write(newFile, async (err) => {
                            if (err) console.error(err);

                            // delete original image file
                            fs.unlinkSync(file);

                            // get binary data of new file
                            let binaryImgData = fs.readFileSync(newFile);

                            // upload the image to the Groupme Image Service
                            let res = await axios.post("https://image.groupme.com/pictures", binaryImgData, {
                                headers: {
                                    "Content-Type": "image/jpeg",
                                    "X-Access-Token": process.env.ACCESS_TOKEN
                                }
                            });

                            // get the GroupMe picture URL
                            const gmImgUrl = res.data.payload.picture_url;

                            // send the catgirl image
                            sendMessage("", [{ "type": "image", "url": gmImgUrl }]);

                            // delete deepfried image file
                            fs.unlinkSync(newFile);
                        });
                })
                .catch(err => {
                    console.error(err);
                });
        });
    }
    else {
        // if no caption specified
        if (args.length === 0) {
            if (picsToSend.length)
                data = picsToSend.shift();

            if (picsToSend.length === 0) {
                // deep copy pics cache array
                picsToSend = JSON.parse(JSON.stringify(PICTURES_RECORD));

                // shuffle the array to allow for random picture sending
                shuffle(picsToSend);
            }
        }
        // if searching for caption
        else {
            // reassemble caption
            const caption = args.join(" ").trim();

            // case-insensitive search thru pic captions
            const regex = new RegExp(["^", caption, "$"].join(""), "i");
            const matches = PICTURES_RECORD.filter(x => regex.test(x.caption));

            // if there was a match found
            if (matches.length) {
                data = matches[0];
            }
        }

        // sanity check
        if (!data) return;

        // download the image
        axios({
            method: "get",
            url: data.img_url,
            responseType: "stream"
        })
        .then(response => {
            return new Promise((resolve, reject) => {
                let file = `${shortid()}.jpeg`;
                let writer = fs.createWriteStream(file);

                response.data.pipe(writer);

                let error = null;

                writer.on('error', err => {
                    error = err;
                    writer.close();
                    reject(err);
                });

                writer.on('close', () => {
                    if (!error) {
                        resolve(file);
                    }
                });
            });
        })
        .then(file => {
            let newFile = `${shortid()}.jpg`;

            // write image file
            jimp.read(file)
                .then(image => {
                    image
                        .quality(1)
                        .dither565()
                        .write(newFile, async (err) => {
                            if (err) console.error(err);

                            // delete original image file
                            fs.unlinkSync(file);

                            // get binary data of new file
                            let binaryImgData = fs.readFileSync(newFile);

                            // upload the image to the Groupme Image Service
                            let res = await axios.post("https://image.groupme.com/pictures", binaryImgData, {
                                headers: {
                                    "Content-Type": "image/jpeg",
                                    "X-Access-Token": process.env.ACCESS_TOKEN
                                }
                            });

                            // get the GroupMe picture URL
                            const gmImgUrl = res.data.payload.picture_url;

                            // send the catgirl image
                            sendMessage(data.caption || "", [{ "type": "image", "url": gmImgUrl }]);

                            // delete deepfried image file
                            fs.unlinkSync(newFile);
                        });
                })
                .catch(err => {
                    console.error(err);
                });
        });
    }
}

/**
 * Takes a picture that a user sends with a caption and saves it to the database.
 * @param {Object[]} attachments 
 * @param {String[]} args 
 */
function submitPicture(attachments, args) {
    // get all the pictures from message attachments
    const pictures = attachments.filter(x => x.type == "image" || "video");

    // reconstruct caption
    let caption = args.join(" ").trim();

    // remove links from caption
    const regex = new RegExp(/(https?:\/\/[^\s]+)/, "g");
    caption = caption.replace(regex, "").trim();

    // if there are pictures attached
    if (pictures.length) 
    {
        // create databse entries for all images with their URLs
        const entry = { img_url: pictures[0].url, caption: caption, numAppearances: 0 };

        // add newly submitted image to pictures record and update Firebase
        picturesRef.push(entry, async (err) => {
            if (!err)
            {
                sendMessage("Submission receieved!");

                // get pictures from database
                PICTURES_RECORD = await getPictures();
            }
        });
    }
}

/**
 * Select a random user to tag with a message appended to the end.
 * @param {String[]} args 
 */
async function selectRandomUser(args) {
    // get all the members of the group
    let response = await axios.get("https://api.groupme.com/v3/groups/" + process.env.GROUP_ID + "?token=" + process.env.ACCESS_TOKEN);
    const members = response.data.response.members;

    // select a random member
    const randomMember = members[Math.floor(Math.random() * members.length)];

    // if there is a message attached
    if (args.length) {
        const message = "@" + randomMember.nickname + ", you have been randomly selected for " + args.join(" ") + ".";

        // send the message
        sendMessage(message, [{"loci": [[1, randomMember.nickname.length]], "type": "mentions", "user_ids": [randomMember.user_id]}]);
    }
    // if no message attached, just select random member and tag them
    else {
        const message = "@" + randomMember.nickname;

        // send the message
        sendMessage(message, [{"loci": [[1, randomMember.nickname.length]], "type": "mentions", "user_ids": [randomMember.user_id]}]);
    }
}

/**
 * Show a leaderboard of all balances in the group.
 */
async function getLeaderboard() {
    // get all the members of the group
    let response = await axios.get("https://api.groupme.com/v3/groups/" + process.env.GROUP_ID + "?token=" + process.env.ACCESS_TOKEN);
    const members = response.data.response.members;

    // create lookup table of nicknames by user ids
    let table = {};
    for (const member of members) 
    {
        table[member.user_id] = member.nickname;
    }
        
    // sort results by points in descending order
    const data = JSON.parse(JSON.stringify(POINTS_RECORD));
    const sortedResults = data.sort((a, b) => b.points - a.points);

    // create the leaderboard
    const leaderboard = sortedResults.map((x, i) => `${i + 1}. ${table[x.user_id]}: ${x.points}`);

    // send the leaderboard
    sendMessage(leaderboard.join("\n"));
}

/**
 * Get a random Wikipedia article from their API and send the link to it.
 */
async function getRandomWikipediaArticle() {
    let res = await axios.get("https://en.wikipedia.org/api/rest_v1/page/random/summary");

    const url = res.data.content_urls.mobile.page;

    sendMessage("Your random Wikipedia article is: " + url);
}

/**
 * Get a random cat picture from an API endpoint and send it to the group.
 */
async function getCat() {
    // get cat image URL
    let res = await axios.get("https://api.thecatapi.com/v1/images/search");
    const catImgUrl = res.data[0].url;

    // get binary data of image
    res = await axios.get(catImgUrl, { responseType: "arraybuffer" });
    const binaryImgData = res.data;

    // upload the image to the Groupme Image Service
    res = await axios.post("https://image.groupme.com/pictures", binaryImgData, {
        headers: {
            "Content-Type": "image/jpeg",
            "X-Access-Token": process.env.ACCESS_TOKEN
        }
    });

    // get the GroupMe picture URL
    const gmImgUrl = res.data.payload.picture_url;

    // send the catgirl image
    sendMessage("", [{ "type": "image", "url": gmImgUrl }]);
}

/**
 * Mention all users with a specific tag in their nickname, or all users in the group.
 * @param {String[]} args 
 */
function mentionUsers(args) {
    if (!args.length) return;
    
    const tag = args[0].toLowerCase();
    axios.get("https://api.groupme.com/v3/groups/" + process.env.GROUP_ID + "?token=" + process.env.ACCESS_TOKEN)
        .then(response => {
            // get all the bof members of the group
            const members = response.data.response.members;

            let toTag = [];
            if (tag == "all")
            {
                // tag all members
                toTag = members;
            }
            else
            {
                // filter by clan tag
                toTag = members.filter(x => x.nickname.toLowerCase().includes(`[${tag}]`));

                // if there is no one to tag
                if (!toTag.length) return;
            }

            // get all the id's of the group members
            const toTagIds = toTag.map(x => x.id);

            // add an @ sign to visually show its a mention
            const mentions = toTag.map(x => "@" + x.nickname);

            // create loci for all the mentions
            let loci = [];
            let messageIndex = 0;
            for (let i = 0; i < mentions.length; i++) {
                // account for spaces in between mentions
                if (i !== 0) messageIndex++;

                const mention = mentions[i];

                loci.push([messageIndex, messageIndex + mention.length]);

                messageIndex += mention.length;
            }

            // get the actual message text
            const messageText = mentions.join(" ");

            sendMessage(messageText, [{ "loci": loci, "type": "mentions", "user_ids": toTagIds }]);
        })
        .catch(error => console.log(error));
}

/**
 * Seperate commands into command and arguments.
 * @param {String} message 
 */
function parseCommand(message) {
    // basic command validation steps
    if (!message) return;
    if (message.length < 2) return;
    if (message[0] != "/") return;
    
    // replace the / activation text and remove any trailing whitespace
    const cleanedCommand = message.replace("/", "").trim();
    
    let command, args;
    [command, ...args] = cleanedCommand.split(" ");
    command = command.toLowerCase();
    
    return { command: command, args: args };
}

/**
 * Send a regular text message.
 * @param {String} message 
 */
function sendMessage(message) {
    // POST message to GroupMe API to send 
    axios.post("https://api.groupme.com/v3/bots/post", {
        bot_id: process.env.BOT_ID,
        text: message
    })
    .then(response => {})
    .catch(error => console.log(error));
}

/**
 * Send a message with attachments.
 * @param {String} message 
 * @param {Object[]} attachments 
 */
function sendMessage(message, attachments) {
    // POST message to GroupMe API to send 
    axios.post("https://api.groupme.com/v3/bots/post", {
        bot_id: process.env.BOT_ID,
        text: message,
        attachments: attachments
    })
    .then(response => {})
    .catch(error => console.log(error));
}

/**
 * Shuffle an array in place.
 * @param {any[]} array 
 */
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }
}
