# Compass Admin — guía de uso

Para el equipo de KIRIA. Explica qué hace cada pantalla y en qué orden se usan.

**Dónde está:** https://compass-admin.thefusebase.app/

**Quién entra:** solo personal de KIRIA. La app pide tu rol en la organización y deja
pasar si sos `member`, `manager` u `owner`. Un cliente que consiga el link ve una
pantalla que dice "Compass Admin es para el equipo de KIRIA" y nada más — no es que se
le oculten los botones, es que el servidor le niega cada pedido.

---

## Las dos aplicaciones, y por qué son dos

| | Portal del cliente | Compass Admin |
| --- | --- | --- |
| Quién entra | el cliente, y el equipo | solo el equipo |
| Para qué | leer documentos y preguntarle al chat | configurar y administrar |
| Carpetas | las ve | las organiza |

El portal del cliente **solo lee y pregunta**. No sube, no borra, no configura — y eso
vale también para el equipo: si entrás al portal como staff, ves un link que dice
"Manage in Compass Admin" y nada más. Antes cada cosa se podía hacer desde los dos
lados; tener dos caminos para lo mismo fue lo que dejó uno roto en producción una hora
sin que nadie lo notara.

---

## El selector de portal

Arriba a la derecha. **Un portal es un cliente**: no hay lista de clientes ni hay que
atar nada a nada. Dos pantallas son "de un portal a la vez" (**Indexing** y
**Settings**) y necesitan que elijas uno primero. Si no elegiste, la pantalla te lo dice
en lugar de mostrarte una tabla vacía.

Cambiar de portal te deja en la misma pantalla. No te devuelve al inicio.

---

## Las siete pantallas

### 1. Portals

Todos los portales de la organización, estén registrados o no.

Un portal **se registra solo** la primera vez que alguien abre la app dentro de él. No
hay que crear un cliente, ni atar nada: el portal se da de alta, se crea su inquilino y
su **librería privada** — la que se llama `<Portal> — files` y va solo a ese portal — y
el visitante ve una lista vacía en vez de un error. El botón **Provision** existe solo
para dejarlo listo antes de que entre nadie.

Las columnas que importan:

- **Last seen** — la más útil de la pantalla. Un portal que existe y nadie abrió nunca
  es la causa más común de "no funciona".
- **Libraries** — de dónde salen sus documentos. Es la única respuesta posible ahora:
  un documento entra por una librería o no entra.
- **Viewer sees** — cuántos documentos ve realmente. Un 0 con librerías tildadas
  está marcado en ámbar, porque es la forma que tiene un problema real.

El botón **Preview** es el más útil de la app: muestra exactamente lo que ese portal le
está mostrando al cliente en este momento, y ahora dice **cómo llegó cada documento** —
de la librería tal. Cuando alguien
pregunta "¿por qué el cliente no ve el documento que subí?", la respuesta casi siempre
aparece acá.

**Pausar** es el interruptor. No hay borrar: borrar la fila dejaría los documentos y las
conversaciones de ese cliente sin ningún portal que los muestre, que es exactamente el
problema que esta pantalla existe para evitar. Pausar es reversible.

### FuseBase manda: qué existe y cómo se llama

Los portales los decide FuseBase, no esta app. Al abrir la pantalla se compara con la
lista de la plataforma (como máximo una vez cada quince minutos) y **Sync now** fuerza
la comparación. Arriba de la tabla siempre dice si corrió, cuándo fue la última vez que
pudo, y qué cambió.

**No hay renombrar acá.** El nombre viene de FuseBase y se reescribe en cada sync, así
que una edición hecha desde acá se desharía sola en un rato — y una edición que se
desface sola es peor que no poder editar, porque parece que funcionó. Renombralo en
FuseBase y apretá **Sync now**.

Si un portal **ya no aparece** en FuseBase, la fila **se queda**, pasa a estado
`missing` y dice cuántos días lleva así. **No se borra nada**: su inquilino, sus
documentos y sus conversaciones siguen ahí. Esto es a propósito: "no aparece" es también
lo que parece una página que cargó a medias, un permiso que cambió, o una caída de cinco
segundos. Y si el portal vuelve a aparecer, la fila se restaura sola.

**Remove permanently** aparece solo para un portal `missing`, y solo después del período
de gracia (siete días por defecto, configurable). Antes de preguntar te dice qué se va a
destruir con números reales — cuántas conversaciones, cuántos documentos, cuántas
librerías privadas — y **hay que escribir el nombre del portal** para confirmarlo. Es la
única acción destructiva de la app. Las librerías **compartidas** no se tocan: pertenecen
también a otros portales, así que se quita el acceso de este, no la librería.

### 2. Libraries

Documentos que van a varios portales, cargados una sola vez.

Es la respuesta al material común: un instructivo que reciben diez clientes se sube a
una librería, se indexa **una vez**, y después se tilda a qué portales va. Diez portales
no cuestan diez veces — cuestan una.

Cómo se usa:

1. Poner un nombre y **Create**.
2. **Open** → arrastrar los PDFs.
3. En *"Which portals receive these files?"*, tildar los portales.

Cada tilde se guarda al instante, sin botón de guardar. Destildar quita el acceso en el
siguiente pedido del portal y **no borra nada**: volver a tildar lo devuelve al momento,
sin costo. Cada tilde y cada destilde queda registrado en **Audit log** con quién, qué y
a qué portal.

**Archivar** saca la librería de circulación: no se ofrece más y no se le pueden agregar
portales nuevos, pero todos los que ya la tenían la siguen viendo. Es lo que se quiere
casi siempre.

**Borrar** solo se puede si nadie la recibe, no tiene documentos, y nunca costó nada
indexarla. Ese historial de costo se guarda a propósito, así que una librería que ya se
usó se archiva, no se borra. La app te lo dice con esas palabras si lo intentás.

**Las carpetas viven acá**, dentro de cada librería, en el panel de `Open`. Crear,
renombrar, mover y borrar; hasta cinco niveles.

- El selector de padre no te ofrece las subcarpetas de la carpeta que estás moviendo,
  porque meter una carpeta dentro de sí misma la haría desaparecer para siempre.
- **Borrar una carpeta no borra nada adentro.** Las subcarpetas suben un nivel y los
  documentos quedan "Unfiled". Una carpeta es una etiqueta, no una caja.
- "Unfiled" no es una carpeta: es cómo se muestran los documentos que no están en
  ninguna. No se puede renombrar ni borrar.
- Dos librerías pueden tener cada una una carpeta *Contratos* y son carpetas
  distintas. En el portal del cliente cada librería es un nodo con su propio árbol, y
  el nombre de la librería nunca se esconde — ni cuando el portal recibe una sola.

**La tabla de documentos** de la librería muestra todo, incluido lo que el cliente *no*
ve: lo que está procesando y lo que falló. Es deliberado: esos son justamente los que
hay que arreglar. Por documento podés cambiarle la carpeta, ver versiones, **Re-index**
y **Delete**.

Borrar le quita el acceso a **todos** los portales que reciben la librería en el momento,
y después limpia el archivo y los pasajes indexados. No se recupera desde acá.

### La librería privada de cada portal

Cada portal tiene una, creada sola con su inquilino, llamada `<Portal> — files`. Es la
respuesta a "quiero darle un archivo a este cliente y a nadie más": se sube ahí y listo.

Por dentro es una librería como cualquier otra — mismo upload, mismas carpetas, mismo
pipeline. La única diferencia es que **no se puede tildar a un segundo portal**: la app
lo rechaza, porque "privada" es la única promesa que hace. Si esos archivos tienen que
ir a más de un cliente, se mueven a una librería compartida, que es una decisión
explícita y queda en el **Audit log**.

### 3. Indexing — *por portal*

Por qué un documento todavía no contesta preguntas.

La columna que importa es **With a vector**. Un documento puede figurar como `indexed`
en todas las demás pantallas, con sus páginas y sus pasajes extraídos, y no ser
alcanzable por ninguna pregunta porque a esos pasajes nunca se les calculó el vector.
Ese fallo no se ve en ningún otro lado, y acá sale marcado como "0 — cannot be cited".

Dos botones, y aparecen solo cuando hay algo que arreglar:

- **Retry N failed** — vuelve a encolar los trabajos fallidos y les resetea los
  intentos. Se usa cuando la causa (una credencial vencida, por ejemplo) ya se
  corrigió.
- **Re-index N unreachable** — vuelve a indexar los documentos sin vector.

### 4. Settings — *por portal*

Límites de costo y comportamiento del chat.

Lo importante de esta pantalla es la columna **"From"**. La configuración se resuelve
en cuatro capas, y gana la más específica:

```
portal  →  cliente  →  organización  →  valor por defecto
```

La pregunta que aparece en soporte nunca es "¿en cuánto está esto?" sino "¿por qué está
en esto?". La columna "From" contesta esa, sin tener que mirar tres tablas.

Lo que se puede ajustar:

- **Modo de recuperación**: *Precision* trae más contexto y responde mejor; *Economy*
  trae menos y sale más barato.
- **Presupuesto mensual de tokens**: al llegarle, las preguntas se rechazan **antes** de
  gastar. Vacío es sin límite.
- **Presupuesto mensual de páginas OCR**: al llegarle, el OCR se detiene en lugar de
  pasarse del tope. Vacío es sin límite.
- **Retención**: cuántos días se guardan los documentos.

Si guardás algo que no es válido, **no se guarda nada** y la pantalla te dice cuál
campo está mal. Antes descartaba el valor inválido, aplicaba el resto y decía
"guardado": si escribías 99999 en un tope, te confirmaba el cambio y el valor no se
movía. Un límite que creés puesto y nunca se aplicó es peor que un error, así que
ahora es un error.

### 5. Alerts

La bandeja de fallas. Cuando algo se rompe de forma que un cliente podría notar,
aparece acá.

Cada alerta trae tres cosas:

1. **Qué pasó**, con nombres y números reales.
2. **Cómo se arregla**, en pasos numerados que nombran la pantalla que hay que abrir.
3. **Qué ve el cliente**, cuando corresponde — así sabés qué se le dijo, y podés
   comprobar que no se filtró nada interno.

También muestra **cuántas veces** pasó. Una alerta que dice "1 vez" y otra que dice
"400 veces" piden respuestas distintas, así que las repeticiones se cuentan sobre la
misma alerta en lugar de llenar la bandeja.

**Acknowledge** es "lo estoy viendo". **Resolve** es "está arreglado". Si el mismo
problema vuelve, aparece una alerta nueva — no se pierde por haber resuelto la anterior.

En **Notification channels** (arriba, plegado) se elige quién recibe avisos por email.
Tres detalles:

- El aviso en la app está siempre activo y no se puede apagar.
- Un destinatario tiene que ser ya miembro de la organización.
- Una falla que se repite manda como máximo un email cada 30 minutos. La cuenta de
  repeticiones sigue subiendo igual.

**Ojo:** los emails de alerta incluyen detalle interno — nombres de tablas, de librerías
y de clientes. Poné una dirección del equipo, no de un cliente.

### 6. Usage

Tokens, páginas OCR y costo del mes, por portal. El costo de una librería no se le
carga a ningún portal: se indexó una vez y la reciben varios, así que cobrárselo a uno
sería arbitrario.

El costo se suma de lo que se cobró en cada momento, no se recalcula con los precios de
hoy. Un cambio de precio no reescribe el historial. Los precios vigentes se muestran
al lado, para que se vean sin dar a entender que se aplicaron para atrás.

### 7. Audit log

Quién hizo qué. Subidas, borrados, cambios de configuración, tildes de librería, y los intentos
rechazados de acceder a datos de otro cliente.

Se filtra por portal y por acción. Es el lugar para contestar "¿quién borró esto?".

---

## Cómo poner un cliente nuevo en marcha

1. Crear su portal en FuseBase y poner la app adentro.
2. **Abrirlo una vez.** Con eso el portal ya existe en el admin, con su inquilino y su
   librería privada. No hay que crear ni atar nada.
3. **Libraries** → abrir su librería privada `<Portal> — files` y subir los primeros
   PDFs. Si son documentos que también reciben otros portales, va en una librería
   compartida y se tildan los portales.
4. **Settings** → poner los presupuestos si querés un tope.
5. **Portals → Preview** → confirmar que el cliente ve lo que tiene que ver.
6. Abrir el portal como cliente y hacer una pregunta.

El paso 5 no es opcional. Es la única pantalla que te muestra el portal desde el lado
del cliente.

Si preferís tenerlo listo antes de que entre nadie, en **Portals** apretá **Provision**
sobre el portal que figura como "not registered" y empezá desde el paso 3.

## Cuando algo no funciona

**"El cliente no ve un documento que subí."** En orden: ¿está `indexed` en la tabla
de su librería? ¿tiene vector en **Indexing**? ¿está tildado ese portal en la librería?
¿aparece en **Portals → Preview**? Preview es la que zanja la discusión: dice, por
documento, si el cliente lo ve y por qué librería le llegó.

**"Un documento quedó en `failed`."** Miralo en **Libraries → Open**, que muestra el error.
Si es un PDF escaneado, necesita OCR — y OCR no está configurado en esta instalación,
así que ese PDF no se puede indexar todavía. Si fue algo pasajero, **Re-index**.

**"Un portal figura como `missing`."** FuseBase dejó de listarlo. No se perdió nada:
sus documentos y conversaciones siguen ahí y la fila dice cuántos días lleva así. Si fue
un error, apretá **Sync now** cuando el portal vuelva a existir y la fila se restaura.
Recién después del período de gracia aparece **Remove permanently**, y hay que escribir
el nombre.

**"El chat dice que no puede responder."** Puede ser que no haya nada indexado en su
alcance, o que el presupuesto de tokens del mes esté agotado — eso último aparece en
**Alerts** y en **Settings**.

**"Hay una alerta crítica que dice `TENANCY_PROBE`."** Si el equipo acaba de correr las
pruebas automáticas, es esperable: esas pruebas intentan justamente ese acceso indebido
para comprobar que se rechaza. La alerta dice qué ruta fue y que el pedido se rechazó
sin exponer datos. Si nadie corrió pruebas, hay que investigarla.

---

## Dos cosas que la app no hace, y no es un olvido

**No podés ver el portal de un cliente desde acá.** **Preview** te dice qué documentos
vería, pero no te mete adentro de su sesión. Es la misma protección que impide que un
cliente vea el portal de otro, y aplica también para nosotros.

**No hay integración con monday.com todavía.** El canal aparece en la lista y se puede
tildar, pero no envía nada — queda registrado como no entregado, para que nadie crea que
avisó cuando no avisó.
