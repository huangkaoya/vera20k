# 王二火大 · VERA Web

Independent browser client combining the VERA20k simulation compiled to WebAssembly with WERHD-style lobby configuration.

All implementation, synchronization patches, builds and generated output belong to this repository. The sibling `vera20k` and `ra2web-werhd` checkouts are read-only upstream inputs. Local retail resources are read-only inputs and generated game artwork is excluded from Git.

The VERA simulation is authoritative; TypeScript handles lobby, transport, input and presentation. This is a separate engine version and does not join existing WERHD production rooms.
