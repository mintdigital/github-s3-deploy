/*
 *   GitHub to S3 Pusher: an AWS Lambda function, triggered by Github Webhook via SNS, to
 *   sync changes on commit to an S3 bucket.
 *
 *   Author: Matt Boggie, New York Times R&D Lab
 *   Copyright: The New York Times Company
 *   Version: 0.01, November 2015   
 */

// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var fs = require('fs');
var archive = require('github-archive-stream');
var GitHub = require('github-api');

var encryptedToken = process.env.GIT_TOKEN;
var decrypted;

// get reference to S3 client 
var s3client = new AWS.S3();
var s3bucket = process.env.S3_BUCKET;
var s3FileKey = process.env.S3_FILE_KEY;

// Github API details
var github_user = process.env.GITHUB_USER;
var github_repo = process.env.GITHUB_REPO;

// This handler is called by the AWS Lambda controller when a new SNS message arrives.
exports.handler = function(event, context) {
  if (decrypted) {
    processEvent(event, context);
  } else {
    // Decrypt code should run once and variables stored outside of the function
    // handler so that these are decrypted once per container
    const kms = new AWS.KMS();
    kms.decrypt({ CiphertextBlob: new Buffer(encryptedToken, 'base64') }, (err, data) => {
      if (err) {
        console.log('Decrypt error:', err);
        return callback(err);
      }
      decrypted = data.Plaintext.toString('ascii');
      processEvent(event, context);
    });
  }
};

function processEvent(event, context) {
  // get the incoming message
  var githubEvent = event.Records[0].Sns.Message;
  var mesgattr = event.Records[0].Sns.MessageAttributes;

  if ((mesgattr.hasOwnProperty('X-Github-Event')) && (mesgattr['X-Github-Event'].Value == "issue_comment")) {
    var eventObj = JSON.parse(githubEvent);

    if (eventObj.action == "created" && eventObj.comment.body == "deeplock" && eventObj.issue.state == "open") {
      var re = new RegExp(/([^\/]*)/);
      var found = re.exec(eventObj.repository.full_name);
      var user = found[0];
      var repo = eventObj.repository.full_name;
      var pull_request = get_pull_request(eventObj.issue.number);

      pull_request.then(function(response) {
        console.log("DEFINITELY Got a pull request opened. Will get code from: ", repo);

        if (!decrypted){
          context.fail("Couldn't retrieve github token. Exiting.");
        } else {
          var sha = response.data.head.sha;
          var archiveOpts = {
            "auth": {
              "user": user,
              "token": decrypted
            },
            "repo": repo,
            "ref": sha,
            "format": 'zipball'
          };
          var output = archive(archiveOpts).
            pipe(fs.createWriteStream('/tmp/' + sha + '.zip'));
  
          output.on('close', function() {
            s3put(output.path, context);
          });
        }       //end token else
      }, function(reason) {
          console.log("something went wrong when trying to get the sha!")
          console.log(reason)
      })
    }         //end if opened message
    else {
      console.log("Message was not a github pull request open. Exiting.");
      console.log(githubEvent);
      console.log(mesgattr);
      console.log(mesgattr['X-Github-Event'].Value);
      console.log(eventObj.action);
      context.succeed();
    }
  }
  else {
    console.log("Message was not a github pull request. Exiting.");
    console.log(githubEvent);
    console.log(mesgattr);
    console.log(mesgattr['X-Github-Event'].Value);
    context.succeed();
  }
}

function get_pull_request(pull_request_id) {
  var gh = new GitHub({
    token: decrypted
  });

  var repo = gh.getRepo(github_user, github_repo);

  return repo.getPullRequest(pull_request_id)
    .then(function(response) {
      return response;
    });
}

function s3put(filename, context){
  console.log("Storing " + filename);

  async.waterfall([
    function store(callback){
      fs.readFile(filename, function(err, data) {
        if (err) { throw err; }

        s3client.putObject({
          Bucket: s3bucket,
          Key: s3FileKey,
          Body: data
        }, callback);
      });
    }
  ],  function done(err){
    if (err){
      context.fail("Couldn't store " + filename + " in bucket " + s3bucket + "; " + err);
    }
    else {
      console.log("Saved " + filename + " to " + s3bucket + " successfully.");
      context.succeed();
    }
  }
  );
}
