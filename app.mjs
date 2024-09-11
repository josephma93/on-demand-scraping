import Docker from 'dockerode';
import express from 'express';
import * as path from "node:path";
import * as fs from "node:fs";

const BASE_PATH_FOR_SCRIPTS = path.resolve(process.env.APP_PATH_FOR_SCRIPTS);
const IS_DEBUG_ON = process.env.APP_IS_DEBUG_ON === 'true';
const docker = new Docker({socketPath: '/var/run/docker.sock'});
const app = express();
app.use(express.json());

docker.ping()
    .then(() => {
        if (IS_DEBUG_ON) {
            console.log('Connected to Docker');
        }
    })
    .catch((err) => {
        console.error('Docker ping error:', err);
        process.exit(1);
    });

function publishFeedback(status, message) {
    const feedback = {status, message};
    // TODO: do something with feedback
}

async function createDockerContainer(jobConfig) {
    const container = await docker.createContainer({
        Image: 'ghcr.io/puppeteer/puppeteer:22.10.0',
        Cmd: ['bash', '-c', jobConfig.bashStartUpCmd],
        HostConfig: {
            Binds: [`${jobConfig.programDirectory}:/home/pptruser/app:ro`],
            AutoRemove: true,
            Init: true,
            CapAdd: ['SYS_ADMIN'],
        },
    });

    if (IS_DEBUG_ON) {
        console.log('Docker container created.');
    }

    return container;
}

async function startDockerContainer(container) {
    if (IS_DEBUG_ON) {
        console.log('Starting Docker container.');
    }

    await container.start();
}

async function captureContainerResultFromLogs(container) {
    try {
        const [
            stdoutStream,
            stderrStream,
        ] = await Promise.all([
            container.attach({
                stream: true,
                stdout: true,
                stderr: false,
                logs: true
            }),
            container.attach({
                stream: true,
                stdout: false,
                stderr: true,
                logs: true
            }),
        ]);

        stderrStream.pipe(process.stderr);

        return new Promise(function collectStdout(resolve, reject) {
            let stdoutData = '';

            stdoutStream.on('data', (data) => {
                stdoutData += data.toString();
            });

            stdoutStream.on('end', () => {
                resolve(stdoutData);
            });

            stdoutStream.on('error', (err) => {
                reject(err);
            });
        });
    } catch (err) {
        console.error('Error attaching to Docker container streams:', err);
    }
}

async function waitForContainerToFinish(container) {
    const data = await container.wait();

    if (IS_DEBUG_ON) {
        console.log('Docker container exited with status:', data.StatusCode);
    }

    if (data.StatusCode === 0) {
        publishFeedback('info', 'Puppeteer script executed successfully.');
    } else {
        throw new Error(`Puppeteer script execution failed with exit code ${data.StatusCode}`);
    }
}

function handleImageNotFoundThenRetry(jobParams) {
    if (IS_DEBUG_ON) {
        console.log('Image not found locally, pulling image from registry.');
    }

    return new Promise(async function pullAndRetry(resolve, reject) {
        function onFinished(err) {
            if (err) {
                console.error('Error pulling Docker image:', err);
                publishFeedback('error', `Failed to pull Docker image: ${err.message}`);
                return;
            }
            // Retry creating and starting the container
            resolve(runDockerCommand(jobParams));
        }

        function onProgress(event) {
            if (IS_DEBUG_ON) {
                console.log('Docker pull progress:', event);
            }
        }

        try {
            await docker.pull('ghcr.io/puppeteer/puppeteer:22.10.0', (err, stream) => {
                if (err) {
                    throw err;
                }
                docker.modem.followProgress(stream, onFinished, onProgress);
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function runDockerCommand(jobParams) {
    // The following commands will run using bash inside the container.
    // All commands will be executed by the `pptruser` user according to: https://github.com/puppeteer/puppeteer/blob/main/docker/Dockerfile
    const commandParts = [
        // Create work directory
        'mkdir -p /home/pptruser/workdir',
        // Copy files from volume to work directory, this makes them reachable inside the container
        'cp -r /home/pptruser/app/{.,}* /home/pptruser/workdir/',
        // Change directory to work directory
        'cd /home/pptruser/workdir',
        // Install dependencies
        'npm ci',
        // Run the Puppeteer script using standard interface
        `node app.mjs`,
    ];
    const bashStartUpCmd = commandParts.join(' && ');

    const jobConfig = {
        bashStartUpCmd,
        programDirectory: jobParams.programDirectory,
    };

    try {
        const container = await createDockerContainer(jobConfig);
        await startDockerContainer(container);
        const containerResult = await captureContainerResultFromLogs(container);
        await waitForContainerToFinish(container);
        return containerResult;
    } catch (err) {
        if (err.statusCode === 404 && err.json && err.json.message.includes('No such image')) {
            return await handleImageNotFoundThenRetry(jobConfig);
        } else {
            throw err;
        }
    }
}

function validateParams(params) {

    function isValidPartialPath(userInputPath) {
        try {
            const realBaseDir = fs.realpathSync(BASE_PATH_FOR_SCRIPTS);
            const realResolvedPath = fs.realpathSync(path.resolve(BASE_PATH_FOR_SCRIPTS, userInputPath));
            return realResolvedPath.startsWith(realBaseDir);
        } catch (err) {
            return false;
        }
    }

    let error;
    validations: {
        const requiredFields = ['programDirectory'];
        for (const field of requiredFields) {
            if (!params[field]) {
                error = `Error: ${field} is required`;
                break validations;
            }
        }

        if (!isValidPartialPath(params.programDirectory)) {
            error = 'Error: Invalid program directory, what are you trying to do Mr. Hacker?';
            break validations;
        }
    }

    return {isValid: !error, error};
}

async function startScrapperJob(req, res) {
    const params = req.body;

    if (IS_DEBUG_ON) {
        console.log('Received HTTP request with params:', params);
    }

    const validationResult = validateParams(params);
    if (!validationResult.isValid) {
        return res.status(400).json({status: 'error', message: validationResult.error});
    }

    try {
        const result = await runDockerCommand(params);
        return res.status(200).json(result);
    } catch (err) {
        console.error('Failed to execute Docker command:', err);
        return res.status(500).json({status: 'error', message: `Puppeteer script execution failed: ${err.message}`});
    }
}

app.post('/start-scrapper-job', startScrapperJob);
