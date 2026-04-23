require('dotenv').config();

async function main() {
  try {
    // Verifica que tengas configurado el project GID
    const projectGid = process.env.ASANA_PROJECT_GID;

    if (!projectGid) {
      console.log('❌ Falta ASANA_PROJECT_GID en tu archivo .env');
      return;
    }

    if (!process.env.ASANA_TOKEN) {
      console.log('❌ Falta ASANA_TOKEN en tu archivo .env');
      return;
    }

    // Llamada a Asana para traer las secciones del proyecto
    const res = await fetch(
      `https://app.asana.com/api/1.0/projects/${projectGid}/sections?opt_fields=name,gid`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
          Accept: 'application/json'
        }
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      console.log('❌ Error en la API de Asana:');
      console.log(errorText);
      return;
    }

    const json = await res.json();

    console.log('\n=== 📂 SECCIONES DE TU PROYECTO ===\n');

    json.data.forEach((sec) => {
      console.log(`📌 Nombre: ${sec.name}`);
      console.log(`🆔 ID: ${sec.gid}`);
      console.log('-----------------------------');
    });

  } catch (err) {
    console.log('❌ Error ejecutando el script:');
    console.log(err);
  }
}

main();
