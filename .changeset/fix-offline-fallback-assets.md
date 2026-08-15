---
"@palomapf-dev/pf-field-core": patch
---

圏外フォールバック(`/offline`)がスタイル無しの素の HTML で表示される欠陥を修正。

Service Worker の install で precacheRoutes の HTML が参照する `/_next/static` の
CSS / JS も一緒に取り込み、fetch では `/_next/static` を Cache First で返すようにした。
オンラインで一度使った資産も貯まるため、閲覧済みページは圏外でも崩れない。
