import { logger } from "../src/utils/logger.js";

// Keep the suite readable while individual logger tests opt into debug output.
logger.setLevel("error");
