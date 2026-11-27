// 앱(Android·웹)이 부르는 서버 (조각 3). 인수 테스트 명령이 시험 포트로 띄운다.
//
//   PORT        듣는 포트 (기본 3100)
//   HOST        기본 0.0.0.0 (Android 가상 기기는 PC를 10.0.2.2로 부름)
//   SEED_USERS  미리 넣을 회원 JSON 배열. 예: [{"username":"kim01","password":"kimpass12"}]
//   WEB_DIST    Expo 웹 빌드 폴더. 주면 같은 서버가 웹 화면도 내보낸다 (웹과 API가 같은 출처라 CORS가 필요 없음)
//
// 회원은 메모리에만 있으므로, 테스트마다 서버를 새로 띄우면 앞 시나리오의 회원이 남지 않는다.
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { buildApp, type UserSeed } from "./app.js";

const users: UserSeed[] = JSON.parse(process.env.SEED_USERS ?? "[]");
const app = buildApp({ users });
if (process.env.WEB_DIST) await app.register(fastifyStatic, { root: resolve(process.env.WEB_DIST) });
const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`login-app 서버: ${port}`);
