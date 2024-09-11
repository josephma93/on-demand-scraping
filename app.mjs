import Docker from 'dockerode';
import express from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import pino from 'pino';
import pinoHttp from 'pino-http';

const BASE_PATH_FOR_SCRIPTS = path.resolve(process.env.APP_PATH_FOR_SCRIPTS);
const IS_DEBUG_ON = process.env.APP_IS_DEBUG_ON === 'true';
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const logger = pino({
    level: IS_DEBUG_ON ? 'debug' : 'info',
    formatters: {
        level(label) {
            return { level: label };
        }
    },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
});

const app = express();
app.use(express.json());
app.use(pinoHttp({ logger }));

docker.ping()
    .then(() => {
        logger.info('Connected to Docker');
    })
    .catch((err) => {
        logger.error({ err }, 'Docker ping error');
        process.exit(1);
    });

async function createDockerContainer(jobConfig) {
    try {
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
        logger.debug('Docker container created', { jobConfig });
        return container;
    } catch (err) {
        logger.error({ err }, 'Error creating Docker container');
        throw err;
    }
}

async function startDockerContainer(container) {
    logger.debug('Starting Docker container.');
    await container.start();
}

async function captureContainerResultFromLogs(container) {
    try {
        const [
            stdoutStream,
            stderrStream,
        ] = await Promise.all([
            container.attach({ stream: true, stdout: true, stderr: false, logs: true }),
            container.attach({ stream: true, stdout: false, stderr: true, logs: true }),
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
                logger.error({ err }, 'Error collecting stdout logs');
                reject(err);
            });
        });
    } catch (err) {
        logger.error({ err }, 'Error attaching to Docker container streams');
        throw err;
    }
}

async function waitForContainerToFinish(container) {
    const data = await container.wait();
    logger.debug('Docker container exited', { statusCode: data.StatusCode });

    if (data.StatusCode !== 0) {
        const errorMsg = `Puppeteer script execution failed with exit code ${data.StatusCode}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
}

function handleImageNotFoundThenRetry(jobParams) {
    logger.debug('Image not found locally, pulling from registry.');

    return new Promise(async function pullAndRetry(resolve, reject) {
        function onFinished(err) {
            if (err) {
                logger.error({ err }, 'Error pulling Docker image');
                return reject(err);
            }
            resolve(runDockerCommand(jobParams));
        }

        function onProgress(event) {
            logger.debug('Docker pull progress', { event });
        }

        try {
            await docker.pull('ghcr.io/puppeteer/puppeteer:22.10.0', (err, stream) => {
                if (err) {
                    throw err;
                }
                docker.modem.followProgress(stream, onFinished, onProgress);
            });
        } catch (err) {
            logger.error({ err }, 'Error during Docker pull');
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
            logger.error({ err }, 'Error running Docker command');
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
            error = 'Error: Invalid program directory';
            break validations;
        }
    }

    return { isValid: !error, error };
}

async function startScrapperJob(req, res) {
    const params = req.body;
    logger.info('Received HTTP request', { params });

    const validationResult = validateParams(params);
    if (!validationResult.isValid) {
        logger.warn('Validation failed', { error: validationResult.error });
        return res.status(400).json({ status: 'error', message: validationResult.error });
    }

    try {
        const result = await runDockerCommand(params);
        logger.info('Scrapper job completed successfully');
        return res.status(200).json(result);
    } catch (err) {
        logger.error({ err }, 'Failed to execute Docker command');
        return res.status(500).json({ status: 'error', message: `Puppeteer script execution failed: ${err.message}` });
    }
}

app.post('/start-scrapper-job', startScrapperJob);

const PORT = process.env.APP_PORT || 3646;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});