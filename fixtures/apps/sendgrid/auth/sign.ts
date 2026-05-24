import type { SignHook } from "@w6w/types";

/**
 * The only hook given the credential. Runs in a network-less worker, so even if
 * this code were hostile it could not exfiltrate the key. It just stamps the
 * Authorization header onto the outbound request.
 */
const sign: SignHook = ({ request, credential }) => {
  const { apiKey } = credential as { apiKey: string };
  request.headers["authorization"] = `Bearer ${apiKey}`;
  return request;
};

export default sign;
