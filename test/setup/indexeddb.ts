/**
 * ユニットテスト全体で IndexedDB を使えるようにする。
 *
 * キューの正しさは「本当に永続化されているか」に依存するので、
 * ストアをモックせず fake-indexeddb の実装に対して検証する。
 */
import "fake-indexeddb/auto";
